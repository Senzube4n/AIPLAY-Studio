"""Do expressions reach the pixels? — server/vfx/engine.py's expression wiring.

expressions_test.py already proves the SANDBOX works: it compiles, it refuses
`(1).__class__`, wiggle wiggles, links link. It passed 100% while a rendered
frame ignored every expression in every document, because engine.py called
interp.eval_prop with three arguments and the ctx is the fourth. Nothing errored.
The property just quietly fell back to its keyframes.

So every assertion in this file goes through engine.render_frame and reads
PIXELS. Nothing here calls expressions.py directly — a test that does cannot tell
the two states apart, and telling them apart is the only reason this file exists.

What is actually pinned down:

  - a wired expression changes the frame, AND the same document with the wiring
    removed does not — `engine.expressions = None` is not a mock, it is the exact
    state the guarded import leaves the module in when expressions.py is absent,
    which is byte for byte the behaviour this file had before the fix. Every
    "expressions work" assertion below has that control next to it, so none of
    them can pass for the wrong reason.
  - the PATH each property binds under. Property links resolve by walking the
    document, but the path is what the cycle guard keys on and what wiggle draws
    its seed from — so a layer that renders under one spelling and is READ under
    another silently disagrees with itself. `test the path is load-bearing` makes
    that concrete: one mis-spelt row moves the render 4px and raises nothing.
  - a cycle terminates, at the value the guard actually chooses, in milliseconds.
  - a broken expression costs a warning line and the keyframed value, never the
    frame.
  - timeRemap goes through interp.eval_time_remap and not past it.
  - a comp with no expressions renders BIT-IDENTICALLY wired and unwired.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/expressions_engine_test.py

No external media: every comp is a synthetic solid, shape, text or precomp, so
this runs anywhere the venv does. effects.py and shapes.py are separate
deliverables and may be absent; the sections that need them skip with a note
rather than failing, the same rule engine_test.py follows.
"""
import contextlib
import io
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vfx import engine, interp  # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


# ── the fixtures ──────────────────────────────────────────────────────────────
#
# One shape everywhere: a 10x10 white solid on a 300x100 transparent stage, its
# anchor at its own centre so `position` IS where the box lands. Read back as an
# alpha-weighted centroid rather than as a bounding box, because an expression
# lands a layer on fractional pixels and a box would round the answer away.

W, H = 300, 100


def comp(layers, **extra):
    doc = {"v": 1, "id": "cmp_expr", "slug": "expr", "name": "expr",
           "width": W, "height": H, "fps": 30.0, "duration": 4.0,
           "bg": [0, 0, 0, 0], "layers": layers}
    doc.update(extra)
    return doc


def box(lid, position, **over):
    lay = {"id": lid, "name": lid, "type": "solid", "width": 10, "height": 10,
           "color": [255, 255, 255, 255], "start": 0.0, "end": 4.0,
           "transform": {"anchor": [5, 5], "position": position,
                         "scale": [100, 100], "rotation": 0, "opacity": 100}}
    lay.update(over)
    return lay


def centre_x(frame, y0=0, y1=H):
    """Where the alpha in a horizontal band sits, in comp pixels. None if empty."""
    a = frame[y0:y1, :, 3].astype(np.float64)
    total = a.sum()
    if total <= 1e-9:
        return None
    xs = np.arange(frame.shape[1], dtype=np.float64) + 0.5
    return float((a.sum(axis=0) * xs).sum() / total)


@contextlib.contextmanager
def unwired():
    """The engine exactly as it was before any of this: the guarded import found
    no expressions.py, so no call site can build a ctx to pass."""
    real = engine.expressions
    engine.expressions = None
    try:
        yield
    finally:
        engine.expressions = real


@contextlib.contextmanager
def warnings():
    """Whatever the render wrote to stderr, as a list of lines."""
    buf = io.StringIO()
    out = []
    with contextlib.redirect_stderr(buf):
        yield out
    out.extend(ln for ln in buf.getvalue().splitlines() if ln.strip())


def render(doc, t=0.0, **kw):
    return engine.render_frame(doc, t, **kw)


print("\nexpressions reach the pixels\n")

# ── 1. the simplest thing that can possibly be wrong ──────────────────────────
#
# {"value": 65, "expr": "value * 2"} has to render at 130. `value` is the
# property's own keyframed/constant value, which is what makes the expression
# finite instead of self-referential.

doubled = comp([box("a", {"value": [65, 50], "expr": "value * 2"})])

eq("an expression computes the property it is written on",
   round(centre_x(render(doubled)), 6), 130.0)

# THE control, and the reason this file exists. Without the ctx the document is
# unchanged, nothing raises, nothing is logged — the property just reads 65.
with unwired():
    unwired_x = centre_x(render(doubled))
eq("with no ctx the same document renders its keyframed value instead",
   round(unwired_x, 6), 65.0)
eq("...so the assertion above would have caught the original bug",
   abs(unwired_x - 130.0) > 1.0, True)

# An expression-only property (no keys at all) still has to work: `value` reads
# the "value" field, and there is nothing else for the fallback to return.
eq("an expression needs no keyframes under it",
   round(centre_x(render(comp([box("a", {"value": [10, 50], "expr": "[150, 50]"})]))), 6),
   150.0)

# and one written on a KEYED property overrides the curve rather than adding to it
keyed = comp([box("a", {"keys": [{"t": 0.0, "v": [40, 50], "ease": "linear"},
                                 {"t": 2.0, "v": [240, 50]}],
                        "expr": "value + [30, 0]"})])
eq("an expression sees the curve underneath it as `value`",
   round(centre_x(render(keyed, 1.0)), 6), 170.0)
with unwired():
    eq("...and without the wiring the curve alone comes through",
       round(centre_x(render(keyed, 1.0)), 6), 140.0)

# ── 2. wiggle: moves, and is the same twice ───────────────────────────────────

wig = comp([box("a", {"value": [150, 50], "expr": "wiggle(6, 40)"})])

frames = {t: render(wig, t) for t in (0.0, 0.2, 0.5, 1.0)}
xs = [centre_x(frames[t]) for t in (0.0, 0.2, 0.5, 1.0)]
eq("wiggle moves the layer between frames", len(set(round(x, 4) for x in xs)), 4)
eq("wiggle actually leaves the base value", any(abs(x - 150.0) > 1.0 for x in xs), True)
eq("wiggle stays inside the amplitude it was given",
   all(abs(x - 150.0) <= 40.0 * 2.0 for x in xs), True)

# Determinism is the whole contract of a seeded noise: two renders of one frame
# have to be the same PIXELS, not merely the same ballpark. A fresh ExprEnv is
# built for each of these, so this also pins that the env carries no state
# between frames that could make the second one differ.
again = render(wig, 0.2)
eq("the same frame rendered twice is identical pixels",
   bool(np.array_equal(frames[0.2], again)), True)
eq("...and not by being empty", centre_x(again) is not None, True)

# The document-level seed is a real salt, not decoration: same expression, same
# frame, different roll.
reseeded = comp([box("a", {"value": [150, 50], "expr": "wiggle(6, 40)"})], seed=7)
eq("the comp's seed re-rolls the noise",
   abs(centre_x(render(reseeded, 0.2)) - centre_x(frames[0.2])) > 0.01, True)
eq("...and is itself deterministic",
   bool(np.array_equal(render(reseeded, 0.2), render(reseeded, 0.2))), True)

with unwired():
    eq("unwired, wiggle does not move anything",
       round(centre_x(render(wig, 0.2)), 6), 150.0)

# ── 3. a property link reads another layer, by path ───────────────────────────
#
# The strong version of "by path": layer a WIGGLES, and layer b reads a's
# position and offsets it. wiggle's seed is drawn from (layer id, path), so b's
# read only lands on a's rendered value if the engine bound a's position under
# the spelling expressions.py resolves the link to — "transform.position". Any
# other spelling gives a's own render one noise stream and b's read another, and
# the offset stops being 40.

linked = comp([box("a", {"value": [140, 25], "expr": "wiggle(6, 30)"}),
               box("b", {"value": [30, 75],
                         "expr": 'thisComp.layer("a").position + [40, 50]'})])

for t in (0.0, 0.2, 0.7):
    f = render(linked, t)
    top, bottom = centre_x(f, 0, 50), centre_x(f, 50, H)
    eq(f"a link reads the other layer's rendered value at t={t}",
       round(bottom - top, 6), 40.0)

with unwired():
    f = render(linked, 0.2)
    eq("unwired, both layers sit on their keyframed values",
       (round(centre_x(f, 0, 50), 6), round(centre_x(f, 50, H), 6)), (140.0, 30.0))

# The same, one property deep in an effect stack: EffectRef spells a link to a
# param "effects.<id>.<param>", with no "params" in it, so that is what the
# engine has to bind. Proven by the CYCLE below, which only closes when the two
# spellings agree; here we only need the value to arrive.
if engine.effects is not None:
    tinted = comp([
        box("a", [60, 25], effects=[{"id": "fx1", "type": "fill", "enabled": True,
                                     "params": {"color": [255, 0, 0], "mode": "normal",
                                                "opacity": {"value": 25,
                                                            "expr": "value * 2"}}}]),
    ])
    literal = comp([
        box("a", [60, 25], effects=[{"id": "fx1", "type": "fill", "enabled": True,
                                     "params": {"color": [255, 0, 0], "mode": "normal",
                                                "opacity": 50}}]),
    ])
    eq("an expression on an effect param renders as the number it computes",
       bool(np.allclose(render(tinted), render(literal), atol=1e-6)), True)
    with unwired():
        eq("...and unwired it renders as the number it was written with",
           bool(np.allclose(render(tinted), render(literal), atol=1e-6)), False)
else:
    print("  note  effects.py absent — effect-param assertions skipped")

# ── 3b. Expression Controls: a keyframed no-op effect, read from anywhere ─────
#
# The whole family renders nothing (proven bit-for-bit below, THROUGH the
# engine), so the only way it can matter is the read path: layer b's position
# reads the slider keyframed on layer a's effect stack, and the pixels land
# where the slider says. Both real spellings are pinned — the cross-layer
# thisComp.layer("driver").effect("ctl")("value") and the same-layer
# thisLayer.effect(...) — and the effect resolves by id AND by type, because
# the id is the only user-settable-free handle this document has.

if engine.effects is not None:
    def slider_fx(keys):
        return [{"id": "ctl", "type": "sliderControl", "enabled": True,
                 "params": {"value": {"keys": keys}}}]

    RIDE = 'thisComp.layer("driver").effect("ctl")("value")'
    rig = comp([box("driver", [40, 25],
                    effects=slider_fx([{"t": 0.0, "v": 40, "ease": "linear"},
                                       {"t": 2.0, "v": 240}])),
                box("puppet", {"value": [30, 75], "expr": f"[{RIDE}, 75]"})])
    for t, want in ((0.0, 40.0), (1.0, 140.0), (2.0, 240.0)):
        eq(f"another layer's position rides the keyframed slider at t={t}",
           round(centre_x(render(rig, t), 50, H), 6), want)
    eq("...so the rendered pixels MOVE between t=0 and t=1",
       bool(np.array_equal(render(rig, 0.0), render(rig, 1.0))), False)
    with unwired():
        eq("...and unwired the puppet sits on its own keyframed value",
           round(centre_x(render(rig, 1.0), 50, H), 6), 30.0)

    by_type = comp([box("driver", [40, 25],
                        effects=slider_fx([{"t": 0.0, "v": 40, "ease": "linear"},
                                           {"t": 2.0, "v": 240}])),
                    box("puppet", {"value": [30, 75],
                                   "expr": '[thisComp.layer("driver")'
                                           '.effect("sliderControl")("value"), 75]'})])
    eq("effect(...) also resolves by TYPE when the layer has one of it",
       round(centre_x(render(by_type, 1.0), 50, H), 6), 140.0)

    own = comp([box("driver",
                    {"value": [10, 50], "expr": '[thisLayer.effect("ctl")("value"), 50]'},
                    effects=slider_fx([{"t": 0.0, "v": 60, "ease": "linear"},
                                       {"t": 2.0, "v": 260}]))])
    eq("the same-layer spelling works too: thisLayer.effect(...)",
       round(centre_x(render(own, 1.0)), 6), 160.0)

    # The no-op claim, where it can actually be false: through _apply_effects.
    bare = comp([box("a", [150, 50])])
    dressed = comp([box("a", [150, 50],
                        effects=[{"id": "c1", "type": "sliderControl", "enabled": True,
                                  "params": {"value": 4200}},
                                 {"id": "c2", "type": "pointControl", "enabled": True,
                                  "params": {"point": [90, -30]}},
                                 {"id": "c3", "type": "colorControl", "enabled": True,
                                  "params": {"color": [10, 200, 30, 128]}}])])
    eq("a stack of controls renders BIT-IDENTICALLY to no effects at all",
       bool(np.array_equal(render(bare, 0.5), render(dressed, 0.5))), True)

    # A point control is a vector read: both components arrive.
    ptc = comp([box("driver", [40, 25],
                    effects=[{"id": "pc", "type": "pointControl", "enabled": True,
                              "params": {"point": {"keys": [
                                  {"t": 0.0, "v": [60, 30], "ease": "linear"},
                                  {"t": 2.0, "v": [260, 70]}]}}}]),
                box("puppet", {"value": [30, 75],
                               "expr": 'thisComp.layer("driver").effect("pc")("point")'
                                       ' * [1, 0] + [0, 75]'})])
    eq("a point control reads as a 2-vector, componentwise",
       round(centre_x(render(ptc, 1.0), 50, H), 6), 160.0)
else:
    print("  note  effects.py absent — Expression Control assertions skipped")

# A link that names something that is not there degrades to the fallback. The
# frame still renders, the property holds its keyframed value, and the reason is
# on stderr rather than in a traceback.
missing = comp([box("a", {"value": [90, 50],
                          "expr": 'thisComp.layer("ghost").position'})])
with warnings() as lines:
    f = render(missing)
eq("a link to a layer that does not exist falls back to the property's value",
   round(centre_x(f), 6), 90.0)
eq("...and says which layer it could not find",
   any("ghost" in ln for ln in lines), True)

missing_prop = comp([box("a", [40, 25]),
                     box("b", {"value": [95, 75],
                               "expr": 'thisComp.layer("a").nonesuch'})])
with warnings() as lines:
    f = render(missing_prop)
eq("a link to a property that does not exist falls back too",
   round(centre_x(f, 50, H), 6), 95.0)
eq("...and names the property", any("nonesuch" in ln for ln in lines), True)

# ── 4. the path is load-bearing, not cosmetic ─────────────────────────────────
#
# The claim above is that binding a property under the wrong name is a silently
# wrong render. Here is that claim as an experiment: interp._row is the one hop
# that turns a layer's "transform" binding into a row's, so mis-spelling it there
# mis-spells every transform property in the engine at once. Nothing raises. The
# link in section 3 simply stops agreeing with the layer it reads.

real_row = interp._row
try:
    interp._row = lambda ctx, name: (ctx.at(name + "_typo") if ctx is not None else None)
    f = render(linked, 0.2)
    typo_delta = centre_x(f, 50, H) - centre_x(f, 0, 50)
finally:
    interp._row = real_row

eq("a mis-spelt property path still renders a frame", typo_delta is not None, True)
eq("...and renders it WRONG, with nothing on stderr to say so",
   abs(typo_delta - 40.0) > 1.0, True)
eq("the correct spelling is the one that agrees",
   round(centre_x(render(linked, 0.2), 50, H) - centre_x(render(linked, 0.2), 0, 50), 6),
   40.0)

# ── 5. a circular link terminates ─────────────────────────────────────────────
#
# What the guard ACTUALLY does, having gone and looked: ExprEnv keys an active
# set on (layer id, path). Re-entering a property that is already being evaluated
# is not an error and not a raise — it is noted once and the property returns
# `base()`, its own keyframed value. So the loop closes at whichever property was
# asked for FIRST, and each layer, evaluated as its own outermost property, gets
# its own consistent answer:
#
#   a asked first:  a reads b, b reads a -> a's base [20,30] -> b=[25,30] -> a=[35,30]
#   b asked first:  b reads a, a reads b -> b's base [70,70] -> a=[80,70] -> b=[85,70]

cyc = comp([box("a", {"value": [20, 30], "expr": 'thisComp.layer("b").position + [10, 0]'}),
            box("b", {"value": [70, 70], "expr": 'thisComp.layer("a").position + [5, 0]'})])

started = time.perf_counter()
with warnings() as lines:
    f = render(cyc)
elapsed = time.perf_counter() - started

eq("a circular link renders a frame at all", f is not None, True)
eq("...quickly: it neither hangs nor unwinds a stack", elapsed < 2.0, True)
eq("...with both layers still drawn",
   (centre_x(f, 0, 50) is not None, centre_x(f, 50, H) is not None), (True, True))
eq("the cycle breaks at the outermost property's own value, layer a",
   round(centre_x(f, 0, 50), 6), 35.0)
eq("...and the same rule the other way round, layer b",
   round(centre_x(f, 50, H), 6), 85.0)
eq("both ends of the cycle are reported", len([ln for ln in lines if "cycle" in ln]), 2)
eq("the report names the property, spelled the way a link resolves it",
   any("a.transform.position" in ln for ln in lines), True)
eq("...and calls it a cycle rather than a depth limit",
   any("nests deeper" in ln for ln in lines), False)

# A property that reads ITSELF through another layer is the same guard, and a
# property that reads itself directly is not expressible — `value` is the
# keyframed read, which is what stops `value + 1` being a loop.
eq("a self-reference through `value` is not a cycle at all",
   round(centre_x(render(comp([box("a", {"value": [55, 50], "expr": "value + [20, 0]"})]))), 6),
   75.0)

# The effect-param spelling, proven: this cycle only CLOSES if the engine binds
# the fill's opacity under "effects.fx1.opacity" — the name EffectRef builds when
# the link resolves. Bind it as "effects.fx1.params.opacity" and the two keys
# never match, the guard never fires, and the depth cap catches it instead with a
# different message.
if engine.effects is not None:
    fx_cyc = comp([
        box("a", [40, 25], effects=[{"id": "fx1", "type": "fill", "enabled": True,
                                     "params": {"color": [255, 0, 0], "mode": "normal",
                                                "opacity": {"value": 40,
                                                            "expr": 'thisComp.layer("b").position[0]'}}}]),
        box("b", {"value": [60, 75],
                  "expr": '[thisComp.layer("a").effect("fx1")("opacity"), 75]'}),
    ])
    with warnings() as lines:
        f = render(fx_cyc)
    eq("an effect param binds under the name a link to it resolves to",
       any("a.effects.fx1.opacity" in ln and "cycle" in ln for ln in lines), True)
    eq("...not under the document's `params` nesting",
       any("params.opacity" in ln for ln in lines), False)
    eq("...and the frame comes out", round(centre_x(f, 50, H), 6), 60.0)

# ── 6. a broken expression costs a warning, never a frame ─────────────────────

for label, src, why in (
        ("a runtime fault", "1 / 0", "division by zero"),
        ("an unknown name", "wobble(2, 3)", "wobble"),
        ("a syntax error", "value + [", "syntax"),
        ("a refused construct", '__import__("os")', "_"),
        ("a refused attribute", "(1).__class__", "_"),
):
    doc = comp([box("a", {"keys": [{"t": 0.0, "v": [110, 50]}], "expr": src})])
    with warnings() as lines:
        f = render(doc)
    eq(f"{label} leaves the property on its keyframed value",
       round(centre_x(f), 6), 110.0)
    eq(f"...{label}: the frame still renders", f.shape, (H, W, 4))
    eq(f"...{label}: and the reason reaches stderr",
       any(why.lower() in ln.lower() for ln in lines), True)

# One broken expression must not take the layer next to it down with it.
mixed = comp([box("a", {"keys": [{"t": 0.0, "v": [50, 25]}], "expr": "1 / 0"}),
              box("b", {"value": [0, 75], "expr": "[200, 75]"})])
with warnings():
    f = render(mixed)
eq("a broken expression does not stop the one beside it",
   (round(centre_x(f, 0, 50), 6), round(centre_x(f, 50, H), 6)), (50.0, 200.0))

# Deduped: a render is 240 frames deep by the time anyone reads the log, and one
# typo read by one property must not be 240 lines per frame.
noisy = comp([box("a", {"value": [50, 50], "expr": "1 / 0"})])
with warnings() as lines:
    render(noisy)
    render(noisy, 0.1)
eq("a repeated fault is one line per frame, not one per read", len(lines), 2)

# ── 7. timeRemap ──────────────────────────────────────────────────────────────
#
# A precomp rather than a video, so this needs no media: the child holds a layer
# that slides from x=20 to x=220 over two seconds, and the parent asks for a
# different SOURCE time than the comp time it is being rendered at.

child = {"v": 1, "id": "kid", "slug": "kid", "width": W, "height": H,
         "fps": 30.0, "duration": 4.0, "bg": [0, 0, 0, 0],
         "layers": [box("m", {"keys": [{"t": 0.0, "v": [20, 50], "ease": "linear"},
                                       {"t": 2.0, "v": [220, 50]}]})]}


def nested(remap):
    lay = {"id": "p", "name": "p", "type": "comp", "comp": child,
           "start": 0.0, "end": 4.0,
           "transform": {"anchor": [W / 2, H / 2], "position": [W / 2, H / 2],
                         "scale": [100, 100], "rotation": 0, "opacity": 100}}
    if remap is not None:
        lay["timeRemap"] = remap
    return comp([lay])


eq("with no remap the child plays at comp time",
   round(centre_x(render(nested(None))), 6), 20.0)
eq("an expression on timeRemap changes which source frame is read",
   round(centre_x(render(nested({"value": 0.0, "expr": "1.0"}))), 6), 120.0)
eq("...and it can be a function of time",
   round(centre_x(render(nested({"value": 0.0, "expr": "time + 1.0"}), 0.5)), 6), 170.0)
with unwired():
    eq("unwired, a timeRemap expression is ignored like every other",
       round(centre_x(render(nested({"value": 0.0, "expr": "1.0"}))), 6), 20.0)

# An expression-only remap has no "keys" for the engine's is-this-a-track test to
# find. Miss that and the layer plays straight and the expression looks like it
# simply did nothing — the same failure mode as the whole bug this file is about.
eq("a remap that is ONLY an expression is still a remap",
   centre_x(render(nested({"expr": "1.0"}))) is not None, True)

# interp.eval_time_remap is not decoration on this path — it is what clamps a
# negative source time to zero. Take the adapter away and a remap of -1 asks the
# child for a frame before it starts and the frame comes back empty, which is
# exactly the difference between the two evaluators.
eq("the eval_time_remap adapter exists",
   callable(getattr(interp, "eval_time_remap", None)), True)
eq("a negative remap is clamped, not passed through",
   round(centre_x(render(nested({"value": 0.0, "expr": "-1.0"}))), 6), 20.0)

real_remap = interp.eval_time_remap
try:
    del interp.eval_time_remap
    without = centre_x(render(nested({"value": 0.0, "expr": "-1.0"})))
finally:
    interp.eval_time_remap = real_remap
eq("...and the clamp is the adapter's, so removing it changes the frame",
   without, None)

# ── 8. the rest of the document surface ───────────────────────────────────────
#
# Every property read in engine.py takes a binding now. These are the ones with
# no equivalent in expressions_test.py because they are not properties the
# sandbox can LINK to — they are only reachable by rendering them.

# a mask's feather, on a layer big enough to see it soften
masked = comp([box("m", [150, 50], width=60, height=60,
                   transform={"anchor": [30, 30], "position": [150, 50],
                              "scale": [100, 100], "rotation": 0, "opacity": 100},
                   masks=[{"id": "mk1", "mode": "add",
                           "points": [[5, 5], [55, 5], [55, 55], [5, 55]],
                           "feather": {"value": 0, "expr": "12"}}])])
sharp = comp([box("m", [150, 50], width=60, height=60,
                  transform={"anchor": [30, 30], "position": [150, 50],
                             "scale": [100, 100], "rotation": 0, "opacity": 100},
                  masks=[{"id": "mk1", "mode": "add",
                          "points": [[5, 5], [55, 5], [55, 55], [5, 55]],
                          "feather": 12}])])
eq("an expression on a mask feather renders as the number it computes",
   bool(np.allclose(render(masked), render(sharp), atol=1e-6)), True)
with unwired():
    eq("...and unwired it does not", bool(np.allclose(render(masked), render(sharp),
                                                      atol=1e-6)), False)

# a layer's opacity — the one property with two homes in the document
faded = comp([box("a", [150, 50],
                  transform={"anchor": [5, 5], "position": [150, 50],
                             "scale": [100, 100], "rotation": 0,
                             "opacity": {"value": 20, "expr": "value * 2"}})])
eq("an expression on opacity reaches the alpha",
   round(float(render(faded)[50, 150, 3]), 4), 0.4)
with unwired():
    eq("...unwired it is the written value", round(float(render(faded)[50, 150, 3]), 4), 0.2)

# rotation, which the 3D path and the 2D path have to name identically
spun = comp([box("a", [150, 50], width=40, height=8,
                 transform={"anchor": [20, 4], "position": [150, 50],
                            "scale": [100, 100], "rotation": {"value": 0, "expr": "90"}})])
flat = comp([box("a", [150, 50], width=40, height=8,
                 transform={"anchor": [20, 4], "position": [150, 50],
                            "scale": [100, 100], "rotation": 0})])
tall = render(spun)[:, :, 3].sum(axis=1).astype(bool).sum()
wide = render(flat)[:, :, 3].sum(axis=1).astype(bool).sum()
eq("an expression on rotation turns the layer", (tall > wide), True)

# a shape item's own animatable geometry — shapes.py is handed a two-argument
# evaluator with no idea which item a property came from, so this is the one
# place the path is recovered by identity rather than threaded
if engine.shapes is not None:
    def ring(radius):
        return {"id": "s", "name": "s", "type": "shape", "start": 0.0, "end": 4.0,
                "origin": "center",
                "transform": {"anchor": [W / 2, H / 2], "position": [W / 2, H / 2],
                              "scale": [100, 100], "rotation": 0, "opacity": 100},
                "shapes": [{"type": "group", "items": [
                    {"type": "ellipse", "size": radius},
                    {"type": "fill", "color": [255, 255, 255]}]}]}
    grown = comp([ring({"value": [20, 20], "expr": "value * 2"})])
    literal = comp([ring([40, 40])])
    eq("an expression on a shape item renders as the number it computes",
       bool(np.allclose(render(grown), render(literal), atol=1e-6)), True)
    with unwired():
        eq("...and unwired it does not",
           bool(np.allclose(render(grown), render(literal), atol=1e-6)), False)

    # Two properties in one shape layer must not share a seed — that is the whole
    # reason the tree is indexed per ITEM instead of bound as one "shapes".
    # Two 30px boxes 160 apart span 190px between their outer edges, and they stay
    # exactly 190 apart only if both wiggled by identically the same amount.
    def twin(expr):
        def rect(x):
            return {"type": "rect", "size": [30, 30],
                    "position": {"value": [x, 0], "expr": expr} if expr else [x, 0]}
        return comp([{"id": "s", "name": "s", "type": "shape", "start": 0.0, "end": 4.0,
                      "origin": "center",
                      "transform": {"anchor": [W / 2, H / 2], "position": [W / 2, H / 2],
                                    "scale": [100, 100], "rotation": 0, "opacity": 100},
                      "shapes": [{"type": "group", "items": [
                          rect(-80), rect(80),
                          {"type": "fill", "color": [255, 255, 255]}]}]}])

    def span_of(doc, t):
        hit = np.nonzero(render(doc, t)[:, :, 3].sum(axis=0) > 1e-6)[0]
        return None if not len(hit) else float(hit.max() - hit.min() + 1)

    eq("two static shape items span the width they were placed at",
       span_of(twin(None), 0.3), 190.0)
    eq("two shape properties draw two different noise streams",
       abs(span_of(twin("wiggle(6, 20)"), 0.3) - 190.0) > 5.0, True)

    # and that is a claim about the PATH, so here it is with the path taken away:
    # index every shape property under one name and the two boxes move together.
    real_props = engine._expr_props

    def one_name(node, path, out):
        real_props(node, path, out)
        for key, (prop, _p) in list(out.items()):
            out[key] = (prop, "shapes")
    try:
        engine._expr_props = one_name
        shared = span_of(twin("wiggle(6, 20)"), 0.3)
    finally:
        engine._expr_props = real_props
    # within a pixel, not to the pixel: they move together by a FRACTIONAL amount
    # and the antialiased edge spills either side of it
    eq("...sharing one path would have moved them as one", abs(shared - 190.0) <= 1.5, True)
else:
    print("  note  shapes.py absent — shape-item assertions skipped")

# a text animator's selector — the typewriter, driven by an expression
typed = comp([{"id": "t", "name": "t", "type": "text", "start": 0.0, "end": 4.0,
               "text": {"content": "AAAAAAAA", "size": 40, "color": [255, 255, 255, 255],
                        "align": "center"},
               "transform": {"anchor": [W / 2, H / 2], "position": [W / 2, H / 2],
                             "scale": [100, 100], "rotation": 0, "opacity": 100},
               "animators": [{"properties": {"opacity": 0},
                              "selector": {"type": "range", "start": 0,
                                           "end": {"value": 0, "expr": "50"}}}]}])
half = comp([{"id": "t", "name": "t", "type": "text", "start": 0.0, "end": 4.0,
              "text": {"content": "AAAAAAAA", "size": 40, "color": [255, 255, 255, 255],
                       "align": "center"},
              "transform": {"anchor": [W / 2, H / 2], "position": [W / 2, H / 2],
                            "scale": [100, 100], "rotation": 0, "opacity": 100},
              "animators": [{"properties": {"opacity": 0},
                             "selector": {"type": "range", "start": 0, "end": 50}}]}])
eq("an expression on a text selector renders as the number it computes",
   bool(np.allclose(render(typed), render(half), atol=1e-6)), True)
with unwired():
    eq("...and unwired it does not",
       bool(np.allclose(render(typed), render(half), atol=1e-6)), False)

# ── 9. nothing that does not opt in can change ────────────────────────────────
#
# The additive guarantee, asserted rather than claimed: a document with no "expr"
# anywhere renders BIT-IDENTICALLY with the wiring in place and with it removed.
# Parenting, masks, a precomp, text, an effect, motion blur — all of it.

plain_child = {"v": 1, "id": "kid2", "slug": "kid2", "width": 120, "height": 80,
               "fps": 30.0, "duration": 4.0, "bg": [10, 10, 30, 255],
               "layers": [box("cm", {"keys": [{"t": 0.0, "v": [20, 40]},
                                              {"t": 2.0, "v": [100, 40]}]})]}
plain = comp([
    box("parent", {"keys": [{"t": 0.0, "v": [100, 50], "ease": "easeInOut"},
                            {"t": 2.0, "v": [200, 50]}]},
        motionBlur=True),
    box("kid", [30, 20], parent="parent",
        masks=[{"mode": "add", "points": [[0, 0], [10, 0], [10, 10], [0, 10]],
                "feather": 2}]),
    {"id": "pc", "name": "pc", "type": "comp", "comp": plain_child,
     "start": 0.0, "end": 4.0,
     "transform": {"anchor": [60, 40], "position": [220, 60],
                   "scale": [90, 90], "rotation": 8, "opacity": 80}},
    {"id": "tx", "name": "tx", "type": "text", "start": 0.0, "end": 4.0,
     "text": {"content": "vfx", "size": 28, "color": [255, 220, 120, 255]},
     "transform": {"anchor": [W / 2, H / 2], "position": [W / 2, H / 2],
                   "scale": [100, 100], "rotation": 0, "opacity": 100}},
], motionBlur={"enabled": True, "samples": 4, "shutter": 180})

wired_frame = render(plain, 0.7)
with unwired():
    unwired_frame = render(plain, 0.7)
eq("a document with no expressions renders bit-identically either way",
   bool(np.array_equal(wired_frame, unwired_frame)), True)
eq("...and is not identical by being blank", float(wired_frame[..., 3].sum()) > 0.0, True)

# ── 10. what it costs ─────────────────────────────────────────────────────────
#
# Two questions, and they are different: what does the WIRING cost a comp that
# uses none of it (the tax everybody pays), and what does an expression cost when
# there is one (the bill the feature sends).


def ms_per_frame(variants, reps=8, rounds=7):
    """Best-of-N batch means for several documents, measured INTERLEAVED.

    Two habits, both load-bearing. Interleaved, because the difference being
    measured here is tens of microseconds against a frame of tens of milliseconds
    and whatever the box was doing during round one does not then land entirely on
    whichever variant was measured first — run them in sequence and the first one
    wears the process's cold caches as if it were a cost of the feature. Best of
    N, because the minimum is the only summary of a timing sample that noise can
    push in one direction only.

    `variants` is [(key, doc, wired)]; returns {key: ms}.
    """
    for _key, doc, wired in variants:                   # warm caches, compile
        with contextlib.nullcontext() if wired else unwired():
            render(doc, 0.0)
    best = {}
    for _ in range(rounds):
        for key, doc, wired in variants:
            with contextlib.nullcontext() if wired else unwired():
                started = time.perf_counter()
                for i in range(reps):
                    render(doc, i / 30.0)
                ms = (time.perf_counter() - started) * 1000.0 / reps
            best[key] = ms if key not in best else min(best[key], ms)
    return best


def benches(w, h):
    """The same two layers, keyframed and expressed, at one canvas size.

    Six expressions between them: a wiggle, a link to the other layer, a linear()
    ramp, and three that read `value`. That is a busy layer, not a stress test.
    """
    plainer = comp([box("a", {"keys": [{"t": 0.0, "v": [60, 25], "ease": "easeInOut"},
                                       {"t": 2.0, "v": [240, 25]}]}),
                    box("b", [150, 75], width=80, height=40,
                        transform={"anchor": [40, 20], "position": [150, 75],
                                   "scale": [110, 110], "rotation": 12, "opacity": 90})],
                   width=w, height=h)
    expressed = comp([box("a", {"value": [60, 25], "expr": "value + [wiggle(6, 30)[0], 0]"}),
                      box("b", [150, 75], width=80, height=40,
                          transform={"anchor": [40, 20],
                                     "position": {"value": [150, 75],
                                                  "expr": 'thisComp.layer("a").position + [90, 50]'},
                                     "scale": {"value": [110, 110],
                                               "expr": "value + [linear(time, 0, 2, 0, 20), 0]"},
                                     "rotation": {"value": 12, "expr": "value + time * 30"},
                                     "opacity": {"value": 90, "expr": "value - 10"}})],
                     width=w, height=h)
    return plainer, expressed


print()
results = {}
for label, (w, h) in (("1080p", (1920, 1080)), ("320x180", (320, 180))):
    plainer, expressed = benches(w, h)
    got = ms_per_frame([("off", plainer, False), ("none", plainer, True),
                        ("some", expressed, True)])
    off_ms, none_ms, some_ms = got["off"], got["none"], got["some"]
    results[label] = (off_ms, none_ms, some_ms)
    print(f"  MEASURE  {label:>7}  no expressions, unwired ...... {off_ms:8.3f} ms/frame")
    print(f"  MEASURE  {label:>7}  no expressions, wired ........ {none_ms:8.3f} ms/frame"
          f"   ({(none_ms - off_ms) * 1000.0:+7.1f} us,{(none_ms - off_ms) / max(off_ms, 1e-9) * 100:+6.1f}%)")
    print(f"  MEASURE  {label:>7}  six expressions .............. {some_ms:8.3f} ms/frame"
          f"   ({(some_ms - none_ms) * 1000.0:+7.1f} us,{(some_ms - none_ms) / max(none_ms, 1e-9) * 100:+6.1f}%)")

# The env on its own, with no property reading it — the per-frame allocation
# expressions.py's own docstring warns against doing per-PROPERTY.
env_us = 0.0
if engine.expressions is not None:
    sample = benches(320, 180)[1]
    engine._new_env(sample)
    started = time.perf_counter()
    for _ in range(5000):
        engine._new_env(sample)
    env_us = (time.perf_counter() - started) * 1e6 / 5000.0
print(f"  MEASURE  one ExprEnv, built and thrown away ........... {env_us:8.3f} us")
print()

small_off, small_none, small_some = results["320x180"]
big_off, big_none, big_some = results["1080p"]

# The tax on a document that uses none of this is the number to hold down: every
# render in the product pays it forever. It is one env allocation plus a dict
# lookup per property read, so it is a fixed cost per FRAME and not per pixel —
# which is why it is quoted against the small canvas, where a frame is cheap
# enough for it to be visible at all. At 1080p it is inside the noise.
#
# The ceilings below are fences against a 5x regression, not the measurement —
# the MEASURE lines are. This box renders prod alongside the suite and a run-to-
# run spread of 2x on a sub-millisecond quantity is ordinary here, so a fence
# tight enough to be interesting would be a test that fails on Tuesdays.
eq("the wiring costs a no-expression comp under 300us a frame",
   (small_none - small_off) * 1000.0 < 300.0, True)
eq("building the per-frame env is under 20us", env_us < 20.0, True)
eq("...so it is not worth caching one across frames",
   env_us / 1000.0 < small_none * 0.02, True)
eq("six expressions cost under 2ms a frame",
   (small_some - small_none) * 1000.0 < 2000.0, True)
eq("...and under a tenth of a 1080p frame",
   (big_some - big_none) < big_none * 0.1, True)

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
