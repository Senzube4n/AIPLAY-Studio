"""Unit tests for the lighting model in server/vfx/lights.py.

Lighting is the other part of a compositor where "it looks right" is not a test.
Every quantity here has a closed form: Lambert says a plane 200px under a point
light is exactly 200/sqrt(dx^2+dy^2+200^2) as bright at (dx,dy) as it is under
the light; inverse-square halves at radius*sqrt(2) and nowhere else; a spot at
height h lands its cone edge at h*tan(coneAngle/2); a caster 200 from the light
and a receiver 300 from it magnify the shadow by exactly 3/2. So almost every
case below PREDICTS THE WHOLE FIELD in the test and compares arrays, rather than
asserting that something got darker.

Three kinds of case, the same split shapes_test.py uses.

  * SWEEPS over the CATALOG: every entry carries a label / group / why / limits,
    every default sits inside its own advertised range, every enum default is one
    of its own options. These fail as one line naming the offenders.
  * ONE MEANINGFUL ASSERTION PER FEATURE - not "it ran" but "an ambient light at
    100 is bit-identical to the input array", "the umbra is 76.5 pixels wide
    because 25.5 * 300/200 is", "a parallel light 100000px away is the same
    frame", "two lights sum rather than one winning".
  * HOSTILE INPUT: NaN, inf, zero intensity, a light sitting exactly on the
    surface it lights, a cone of 0 and of 180 degrees, a radius of 0 under the
    inverse-square law, integer pixels, a matrix full of NaN.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/lights_test.py

The camera is a two-line stub with a `.pos`, deliberately: `shade` duck-types it,
so this suite proves the contract the engine has to meet rather than importing
engine.py and proving that today's engine meets itself. The layer matrices are
built here too, by the same Rx*Ry*Rz composition the engine documents, for the
same reason.

numpy / cv2, plus interp.py for the keyframed cases - "animatable" is a claim
about interp and not about this module, so the animated tests go through the real
evaluator.
"""
import math
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import interp                                              # noqa: E402
import lights                                              # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print("  ok    %s" % name)
    else:
        FAIL += 1
        print("  FAIL  %s\n          got %r, wanted %r" % (name, got, want))


def near(name, got, want, tol):
    global PASS, FAIL
    d = abs(float(got) - float(want))
    if d <= tol:
        PASS += 1
        print("  ok    %s" % name)
    else:
        FAIL += 1
        print("  FAIL  %s\n          got %.9g, wanted %.9g (off by %.3g, tol %g)"
              % (name, float(got), float(want), d, tol))


# ---------------------------------------------------------------------------
# the scene: one plane, one stub camera, and matrices built the engine's way
# ---------------------------------------------------------------------------

COMP = {"width": 1920, "height": 1080, "duration": 10.0}
CX, CY = 960.0, 540.0
N = 201                      # odd, so pixel [100,100] is EXACTLY the centre
HALF = (N - 1) / 2.0


class Cam:
    """Everything `shade` is allowed to want from a camera."""

    def __init__(self, pos=(CX, CY, -1500.0)):
        self.pos = np.array(pos, dtype=np.float64)


CAM = Cam()


def rot3(rx, ry, rz):
    """Rx*Ry*Rz from degrees - the engine's composition order, restated here so
    the test does not inherit a bug from the thing it is testing."""
    cx, sx = math.cos(math.radians(rx)), math.sin(math.radians(rx))
    cy, sy = math.cos(math.radians(ry)), math.sin(math.radians(ry))
    cz, sz = math.cos(math.radians(rz)), math.sin(math.radians(rz))
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float64)
    return mx @ my @ mz


def m4_of(position=(CX, CY, 0.0), anchor=(HALF + 0.5, HALF + 0.5, 0.0),
          rot=(0.0, 0.0, 0.0), scale=(100.0, 100.0, 100.0)):
    lin = rot3(*rot) @ np.diag([s / 100.0 for s in scale])
    out = np.eye(4, dtype=np.float64)
    out[:3, :3] = lin
    out[:3, 3] = np.asarray(position, dtype=np.float64) - lin @ np.asarray(anchor,
                                                                          dtype=np.float64)
    return out


M4 = m4_of()                 # pixel [i,j] sits at world (960 + j - 100, 540 + i - 100, 0)


def white(n=N):
    return np.ones((n, n, 4), dtype=np.float32)


def light(kind="point", pos=None, **spec):
    lay = {"id": "lt_%s_%d" % (kind, len(spec)), "type": "light",
           "light": dict(spec, kind=kind)}
    if pos is not None:
        lay["transform"] = {"position": list(pos)}
    return lay


def rig(*layers):
    return lights.rig(list(layers), 0.0, comp=COMP)


def mat(**kw):
    """A layer dict carrying only material options."""
    return {"id": "ly_test", "threeD": True, "material": kw}


LAMBERT = mat(ambient=0, diffuse=100, specular=0)


def shade(rgba, r, layer=LAMBERT, m4=M4, camera=CAM, **kw):
    return lights.shade(rgba, m4, camera, r, layer, **kw)


def grid(n=N):
    """(dx, dy) of every pixel from the layer's centre, in comp px."""
    j = np.arange(n, dtype=np.float64) - (n - 1) / 2.0
    return j[None, :], j[:, None]


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


# ===========================================================================
print("\nlights\n")
print("  -- the catalog contract --")

bad = [k for k, e in lights.CATALOG.items()
       if not (e.get("label") and e.get("group") and e.get("why") and
               isinstance(e.get("params"), dict) and e["params"])]
eq("every entry has a label, a group, a why and parameters", bad, [])

eq("every group is one the catalog declares",
   sorted({e["group"] for e in lights.CATALOG.values()} - set(lights.GROUP_ORDER)), [])

eq("every entry names what it cannot do",
   [k for k, e in lights.CATALOG.items() if not e.get("limits")], [])

bad = []
for k, e in lights.CATALOG.items():
    for pname, p in e["params"].items():
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append("%s.%s" % (k, pname))
        if p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append("%s.%s" % (k, pname))
        if p["type"] == "color" and not (3 <= len(p["default"]) <= 4
                                         and all(0 <= c <= 255 for c in p["default"])):
            bad.append("%s.%s" % (k, pname))
        if not p.get("desc"):
            bad.append("%s.%s (no desc)" % (k, pname))
eq("every default sits inside its own advertised range", bad, [])

eq("the light kinds in the catalog are exactly KINDS",
   sorted(k for k, e in lights.CATALOG.items() if e["group"] == "Light"),
   sorted(lights.KINDS))
eq("the falloff options in the catalog are exactly FALLOFFS",
   lights.CATALOG["point"]["params"]["falloff"]["options"], lights.FALLOFFS)

import json                                                # noqa: E402
_cat = json.loads(json.dumps(lights.catalog()))
eq("the catalog survives a JSON round trip", sorted(_cat),
   ["falloffs", "groups", "kinds", "lights", "limits", "names"])
eq("the module-level limits are served too", len(_cat["limits"]) >= 4, True)

eq("material defaults are AE's", lights.material({}),
   {"acceptsLights": True, "ambient": 100.0, "diffuse": 50.0, "specular": 50.0,
    "shininess": 5.0, "castsShadows": False, "acceptsShadows": True})
near("shininess 0 is exponent 2", lights.spec_exponent(0), 2.0, 0)
near("shininess 100 is exponent 128", lights.spec_exponent(100), 128.0, 0)
near("shininess 50 is halfway", lights.spec_exponent(50), 65.0, 1e-9)


print("\n  -- the pixel contract --")

r1 = rig(light("point", (CX, CY, -200.0)))
src = white()
before = src.copy()
out = shade(src, r1)
eq("the input array is never written to", np.array_equal(src, before), True)
eq("the result is float32 (H, W, 4)", (out.dtype, out.shape), (np.float32, (N, N, 4)))
eq("alpha comes back bit-identical", np.array_equal(out[..., 3], src[..., 3]), True)
eq("the result stays inside 0..1",
   bool(out.min() >= 0.0 and out.max() <= 1.0), True)
eq("nothing comes back NaN", bool(np.isfinite(out).all()), True)

eq("no light layers means no rig at all", lights.rig([{"type": "solid"}], 0.0, comp=COMP), None)
eq("a None rig hands back THE SAME ARRAY", lights.shade(src, M4, CAM, None, LAMBERT) is src,
   True)
eq("acceptsLights: false hands back THE SAME ARRAY",
   shade(src, r1, mat(acceptsLights=False)) is src, True)
eq("...which is therefore bit-identical to no lights",
   np.array_equal(shade(src, r1, mat(acceptsLights=False)),
                  lights.shade(src, M4, CAM, None, LAMBERT)), True)
eq("integer pixels are refused rather than run 255x too bright",
   lights.shade(np.ones((4, 4, 4), dtype=np.uint8), M4, CAM, r1, LAMBERT).dtype, np.uint8)
eq("a non-image argument comes straight back",
   lights.shade("nope", M4, CAM, r1, LAMBERT), "nope")


print("\n  -- ambient: the flat term --")

amb100 = rig(light("ambient", intensity=100))
eq("an ambient light of 100 on a white layer is a NO-OP, bit for bit",
   np.array_equal(shade(white(), amb100, mat(ambient=100)), white()), True)
eq("...and it is literally the same array object",
   shade(src, amb100, mat(ambient=100)) is src, True)
near("material ambient 50 halves it exactly",
     shade(white(), amb100, mat(ambient=50))[..., :3].max(), 0.5, 0)
eq("two ambients of 50 are bit-identical to one of 100",
   np.array_equal(shade(white(), rig(light("ambient", intensity=50),
                                     light("ambient", intensity=50)), mat(ambient=100)),
                  shade(white(), amb100, mat(ambient=100))), True)
red = shade(white(), rig(light("ambient", color=[255, 0, 0])), mat(ambient=100))
eq("a red ambient light leaves only red",
   [float(red[100, 100, c]) for c in range(3)], [1.0, 0.0, 0.0])
eq("an ambient light casts nothing, whatever its castsShadows says",
   lights.rig([light("ambient", castsShadows=True)], 0.0, comp=COMP).lights[0].casts, False)


print("\n  -- a point light obeys Lambert, to the pixel --")

H = 200.0
r_pt = rig(light("point", (CX, CY, -H), falloff="none"))
out = shade(white(), r_pt)
dx, dy = grid()
predicted = (H / np.sqrt(dx * dx + dy * dy + H * H)).astype(np.float64)

near("the whole field is N.L, computed here and not sampled from a render",
     float(np.abs(out[..., 0].astype(np.float64) - predicted).max()), 0.0, 1e-5)
near("the centre, directly under the light, is fully lit", out[100, 100, 0], 1.0, 1e-6)
near("the corner is 200/sqrt(100^2+100^2+200^2)", out[0, 0, 0],
     H / math.sqrt(100.0 ** 2 + 100.0 ** 2 + H ** 2), 1e-5)
eq("so the centre is brighter than the corner",
   float(out[100, 100, 0]) > float(out[0, 0, 0]), True)
near("and brighter by exactly the ratio the cosine predicts",
     float(out[100, 100, 0]) / float(out[0, 0, 0]),
     float(predicted[100, 100] / predicted[0, 0]), 1e-5)
near("material diffuse 50 - AE's default - halves the whole field",
     float(shade(white(), r_pt, mat(ambient=0, diffuse=50, specular=0))[100, 100, 0]),
     0.5, 1e-6)

# turning the layer edge-on to the light kills it, and the two-sided flip means
# turning it right around does NOT
side = shade(white(), r_pt, m4=m4_of(rot=(0.0, 90.0, 0.0)))
eq("a layer edge-on to the camera and the light goes dark",
   float(side[..., :3].max()) < 0.02, True)
eq("a layer turned right around is still lit - lighting is two-sided",
   float(shade(white(), r_pt, m4=m4_of(rot=(0.0, 180.0, 0.0)))[100, 100, 0]) > 0.99, True)


print("\n  -- falloff --")


def centre(r, layer=LAMBERT):
    return float(shade(white(), r, layer)[100, 100, 0])


near("falloff none: the same at 200px and at 2000px",
     centre(rig(light("point", (CX, CY, -2000.0), falloff="none"))), 1.0, 1e-5)

near("inverse square is exactly 1 AT the radius",
     centre(rig(light("point", (CX, CY, -200.0), falloff="inverseSquare", radius=200))),
     1.0, 1e-4)
near("inverse square HALVES at radius*sqrt(2), and nowhere else",
     centre(rig(light("point", (CX, CY, -200.0 * math.sqrt(2.0)),
                      falloff="inverseSquare", radius=200))), 0.5, 1e-4)
near("inverse square is a QUARTER at radius*2",
     centre(rig(light("point", (CX, CY, -400.0), falloff="inverseSquare", radius=200))),
     0.25, 1e-4)
near("inverse square is CLAMPED inside the radius, not infinite",
     centre(rig(light("point", (CX, CY, -100.0), falloff="inverseSquare", radius=200))),
     1.0, 1e-6)

near("smooth falloff is untouched at the radius",
     centre(rig(light("point", (CX, CY, -100.0), falloff="smooth",
                      radius=100, falloffDistance=200))), 1.0, 1e-6)
near("smooth falloff is half at radius + falloffDistance/2 - smoothstep(0.5) is 0.5",
     centre(rig(light("point", (CX, CY, -200.0), falloff="smooth",
                      radius=100, falloffDistance=200))), 0.5, 1e-4)
near("smooth falloff is nothing at radius + falloffDistance",
     centre(rig(light("point", (CX, CY, -300.0), falloff="smooth",
                      radius=100, falloffDistance=200))), 0.0, 1e-6)
near("a smooth falloff with nowhere to ramp is a hard cut, inside",
     centre(rig(light("point", (CX, CY, -200.0), falloff="smooth",
                      radius=250, falloffDistance=0))), 1.0, 1e-5)
near("...and outside",
     centre(rig(light("point", (CX, CY, -200.0), falloff="smooth",
                      radius=150, falloffDistance=0))), 0.0, 1e-6)


print("\n  -- a spot's cone lands where the angle says --")


SN, SC = 301, 150          # a wider plane: a 60 degree cone at h=200 reaches 115px out
SM4 = m4_of(anchor=(SC + 0.5, SC + 0.5, 0.0))


def spot_row(angle, feather, h=200.0):
    r = rig(light("spot", (CX, CY, -h), pointOfInterest=[CX, CY, 0.0],
                  coneAngle=angle, coneFeather=feather, falloff="none"))
    return shade(white(SN), r, m4=SM4)[SC, :, 0].astype(np.float64)


def spot_predict(angle, feather, h=200.0):
    rho = np.abs(np.arange(SN, dtype=np.float64) - SC)
    theta = np.arctan2(rho, h)
    half = math.radians(angle * 0.5)
    inner = half * (1.0 - feather / 100.0)
    if half - inner < 1e-9:
        cone = (theta <= half).astype(np.float64)
    else:
        cone = np.where(theta <= inner, 1.0,
                        np.where(theta >= half, 0.0,
                                 smoothstep((half - theta) / (half - inner))))
    return np.cos(theta) * cone


near("a hard-edged 60 degree cone matches the closed form across a whole row",
     float(np.abs(spot_row(60, 0) - spot_predict(60, 0)).max()), 0.0, 1e-4)
row = spot_row(60, 0)
edge = 200.0 * math.tan(math.radians(30.0))               # 115.470...
lit_px = np.nonzero(row > 0.0)[0]
near("the cone edge is at h*tan(coneAngle/2)",
     0.5 * (lit_px.max() - lit_px.min()), edge, 1.0)
eq("just inside the edge is lit", float(row[SC + int(edge) - 1]) > 0.0, True)
eq("just outside the edge is not", float(row[SC + int(edge) + 2]), 0.0)

near("a 50% feather matches the closed form too",
     float(np.abs(spot_row(60, 50) - spot_predict(60, 50)).max()), 0.0, 1e-4)
soft = spot_row(60, 50)
band = soft[SC + 40:SC + int(edge) + 1]
eq("the feather is a real gradient, not two steps",
   int(np.count_nonzero((band > 0.02) & (band < 0.98))) > 20, True)
eq("...and it is monotone across the band",
   bool(np.all(np.diff(band) <= 1e-6)), True)
theta_mid = math.radians(30.0) * 0.75                     # halfway from inner to outer
rho_mid = 200.0 * math.tan(theta_mid)
near("at the angular midpoint of the feather the cone is exactly half",
     float(np.interp(SC + rho_mid, np.arange(SN), soft)) / math.cos(theta_mid),
     0.5, 2e-3)

eq("a cone of 0 degrees emits nothing", float(spot_row(0, 0).max()), 0.0)
near("a cone of 180 degrees is a point light again",
     float(np.abs(spot_row(180, 0) - shade(white(SN), rig(light(
         "point", (CX, CY, -200.0), falloff="none")), m4=SM4)[SC, :, 0]).max()), 0.0, 1e-6)
eq("a 100% feather still reaches 1 on the axis", float(spot_row(60, 100).max()) > 0.99, True)


print("\n  -- a parallel light does not fall off, at any distance --")


def par(pos, poi, **kw):
    return shade(white(), rig(light("parallel", pos, pointOfInterest=list(poi), **kw)))


straight = par((CX, CY, -500.0), (CX, CY, 0.0))
eq("straight down at the layer, every pixel is identical",
   float(straight[..., 0].max() - straight[..., 0].min()) < 1e-7, True)
near("...and fully lit", float(straight[100, 100, 0]), 1.0, 1e-6)
eq("moving it 200x further away changes NOTHING",
   np.array_equal(par((CX, CY, -100000.0), (CX, CY, 99999.0)), straight), True)
eq("and a falloff on it is ignored, because it has no distance to fall off over",
   np.array_equal(par((CX, CY, -500.0), (CX, CY, 0.0),
                      falloff="inverseSquare", radius=1), straight), True)
near("at 45 degrees the whole layer reads cos(45)",
     float(par((CX, CY, -500.0), (CX + 500.0, CY, 0.0))[100, 100, 0]),
     math.sqrt(0.5), 1e-6)
eq("a parallel light aimed AWAY leaves the layer black",
   float(par((CX, CY, -500.0), (CX, CY, -1000.0))[..., :3].max()), 0.0)


print("\n  -- two lights sum; neither one wins --")

la = light("point", (CX - 300.0, CY, -200.0), intensity=40, falloff="none")
lb = light("point", (CX + 300.0, CY, -200.0), intensity=40, falloff="none")
a = shade(white(), rig(la))
b = shade(white(), rig(lb))
ab = shade(white(), rig(la, lb))
near("two point lights add rather than compete",
     float(np.abs(ab[..., :3] - (a[..., :3] + b[..., :3])).max()), 0.0, 1e-6)
eq("nothing was clipped on the way, so that sum means something",
   float(ab[..., :3].max()) < 0.99, True)
eq("and the sum really is brighter than either alone",
   float(ab[100, 100, 0]) > float(max(a[100, 100, 0], b[100, 100, 0])) + 0.1, True)
eq("an ambient and a point sum too",
   float(np.abs(shade(white(), rig(la, light("ambient", intensity=30)),
                      mat(ambient=100, diffuse=100, specular=0))[..., :3]
                - (a[..., :3] + 0.3)).max()) < 1e-6, True)


print("\n  -- specular --")

SPEC = mat(ambient=0, diffuse=0, specular=100, shininess=0)
lp = np.array([CX, CY, -H])
cp = CAM.pos
out = shade(white(), rig(light("point", tuple(lp), falloff="none")), SPEC)
dx, dy = grid()
dl = np.stack([np.broadcast_to(-dx, (N, N)), np.broadcast_to(-dy, (N, N)),
               np.full((N, N), -H)], axis=-1)
dv = np.stack([np.broadcast_to(-dx, (N, N)), np.broadcast_to(-dy, (N, N)),
               np.full((N, N), float(cp[2]))], axis=-1)
lhat = dl / np.linalg.norm(dl, axis=-1, keepdims=True)
vhat = dv / np.linalg.norm(dv, axis=-1, keepdims=True)
hv = lhat + vhat
ndoth = (-hv[..., 2]) / np.linalg.norm(hv, axis=-1)
predicted = np.clip(ndoth, 0, 1) ** lights.spec_exponent(0)

near("the highlight is Blinn-Phong, predicted here from N, L and V",
     float(np.abs(out[..., 0].astype(np.float64) - predicted).max()), 0.0, 2e-4)
near("dead on the axis, N.H is 1 and the highlight is full", out[100, 100, 0], 1.0, 1e-5)
tight = shade(white(), rig(light("point", tuple(lp), falloff="none")),
              mat(ambient=0, diffuse=0, specular=100, shininess=100))
eq("raising shininess tightens the highlight",
   int((tight[..., 0] > 0.5).sum()) < int((out[..., 0] > 0.5).sum()), True)
eq("specular 0 removes it entirely",
   float(shade(white(), rig(light("point", tuple(lp))),
               mat(ambient=0, diffuse=0, specular=0))[..., :3].max()), 0.0)
eq("no camera means no highlight to place",
   float(lights.shade(white(), M4, None, rig(light("point", tuple(lp))),
                      SPEC)[..., :3].max()), 0.0)
eq("the highlight takes the LIGHT's colour, not the surface's",
   [round(float(shade(np.concatenate([np.zeros((N, N, 3), np.float32),
                                      np.ones((N, N, 1), np.float32)], axis=-1),
                      rig(light("point", tuple(lp), color=[255, 0, 0])),
                      SPEC)[100, 100, c]), 4) for c in range(3)], [1.0, 0.0, 0.0])


print("\n  -- shadows: a plane onto a plane, and the umbra is arithmetic --")

RN = 401                                    # receiver, centred, pixel [200,200] is (960,540)
RM4 = m4_of(anchor=((RN - 1) / 2.0 + 0.5, (RN - 1) / 2.0 + 0.5, 0.0))
CN = 51                                     # caster half-width is 25.5 layer px
CM4 = m4_of(position=(CX, CY, -100.0),
            anchor=((CN - 1) / 2.0 + 0.5, (CN - 1) / 2.0 + 0.5, 0.0))
BLOCK = lights.caster(np.ones((CN, CN, 4), dtype=np.float32), CM4, 1.0, key="ly_block")


def lit(r, casters=(), layer=LAMBERT, m4=RM4, **kw):
    return lights.shade(np.ones((RN, RN, 4), dtype=np.float32), m4, CAM, r, layer,
                        casters=casters, **kw)


def umbra(r, casters, row=200):
    """How many pixels of one row lost more than half their light."""
    base = lit(r)[row, :, 0].astype(np.float64)
    shad = lit(r, casters)[row, :, 0].astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(base > 1e-6, shad / np.maximum(base, 1e-9), 1.0)
    return ratio, np.nonzero(ratio < 0.5)[0]


r_sh = rig(light("point", (CX, CY, -300.0), falloff="none", castsShadows=True))
ratio, dark = umbra(r_sh, [BLOCK])
# similar triangles: light 200 from the caster, 300 from the receiver -> 3/2
near("the umbra is 51 * 300/200 wide, because that is what similar triangles say",
     float(dark.size), 51.0 * 300.0 / 200.0, 2.0)
near("...and it is centred under the caster",
     0.5 * float(dark.min() + dark.max()), 200.0, 1.0)
near("inside the umbra - past the edge pixels the caster only half covers - the "
     "light is gone entirely",
     float(ratio[dark[2]:dark[-3] + 1].max()), 0.0, 1e-5)
eq("outside it, nothing was touched",
   float(np.abs(ratio[:dark.min() - 2]).min()) > 0.999, True)
eq("a shadow never touches alpha",
   np.array_equal(lit(r_sh, [BLOCK])[..., 3], np.ones((RN, RN), dtype=np.float32)), True)

near("a light 2x further from the caster casts a 2x umbra",
     float(umbra(rig(light("point", (CX, CY, -200.0), falloff="none",
                           castsShadows=True)), [BLOCK])[1].size),
     51.0 * 200.0 / 100.0, 2.0)

eq("shadowDarkness 0 is bit-identical to no caster at all",
   np.array_equal(lit(rig(light("point", (CX, CY, -300.0), falloff="none",
                                castsShadows=True, shadowDarkness=0)), [BLOCK]),
                  lit(r_sh)), True)
eq("a light with castsShadows off casts none",
   np.array_equal(lit(rig(light("point", (CX, CY, -300.0), falloff="none")), [BLOCK]),
                  lit(r_sh)), True)
eq("draft skips shadows outright",
   np.array_equal(lit(r_sh, [BLOCK], draft=True), lit(r_sh)), True)
near("shadowDarkness 40 takes exactly 40% of the light",
     float(umbra(rig(light("point", (CX, CY, -300.0), falloff="none",
                           castsShadows=True, shadowDarkness=40)), [BLOCK])[0].min()),
     0.6, 1e-4)

eq("a caster BEYOND the receiver casts nothing - the ray test, not a fudge",
   np.array_equal(lit(r_sh, [lights.caster(np.ones((CN, CN, 4), np.float32),
                                           m4_of(position=(CX, CY, 100.0),
                                                 anchor=((CN - 1) / 2.0 + 0.5,
                                                         (CN - 1) / 2.0 + 0.5, 0.0)),
                                           1.0, key="behind")]), lit(r_sh)), True)
eq("a caster BEHIND the light casts nothing either",
   np.array_equal(lit(r_sh, [lights.caster(np.ones((CN, CN, 4), np.float32),
                                           m4_of(position=(CX, CY, -400.0),
                                                 anchor=((CN - 1) / 2.0 + 0.5,
                                                         (CN - 1) / 2.0 + 0.5, 0.0)),
                                           1.0, key="past")]), lit(r_sh)), True)
eq("a plane cannot shadow itself",
   np.array_equal(lit(r_sh, [lights.caster(np.ones((RN, RN, 4), np.float32), RM4,
                                           1.0, key="ly_test")],
                      layer={"id": "ly_test", "threeD": True,
                             "material": {"ambient": 0, "diffuse": 100, "specular": 0}}),
                  lit(r_sh)), True)

half_a = lights.caster(np.full((CN, CN), 0.5, dtype=np.float32), CM4, 1.0, key="ly_half")
near("a half-transparent caster takes half the light",
     float(umbra(r_sh, [half_a])[0].min()), 0.5, 1e-4)

par_sh = rig(light("parallel", (CX, CY, -500.0), pointOfInterest=[CX, CY, 0.0],
                   castsShadows=True))
near("a parallel light's shadow is the caster's own size - no convergence",
     float(umbra(par_sh, [BLOCK])[1].size), 51.0, 2.0)
tilt = rig(light("parallel", (CX, CY, -500.0), pointOfInterest=[CX + 250.0, CY, -250.0],
                 castsShadows=True))
_, dark_t = umbra(tilt, [BLOCK])
near("tilting it 45 degrees slides the shadow by the caster's height, exactly",
     0.5 * float(dark_t.min() + dark_t.max()) - 200.0, 100.0, 1.5)
near("...and the shadow keeps its width",
     float(dark_t.size), 51.0, 2.0)

soft_r = rig(light("point", (CX, CY, -300.0), falloff="none", castsShadows=True,
                   shadowDiffusion=12))
soft_ratio, _ = umbra(soft_r, [BLOCK])
hard_ratio = ratio
eq("shadowDiffusion turns the edge into a gradient",
   int(np.count_nonzero((soft_ratio > 0.05) & (soft_ratio < 0.95)))
   > int(np.count_nonzero((hard_ratio > 0.05) & (hard_ratio < 0.95))) + 10, True)

second = lights.caster(np.ones((CN, CN, 4), dtype=np.float32),
                       m4_of(position=(CX + 120.0, CY, -100.0),
                             anchor=((CN - 1) / 2.0 + 0.5, (CN - 1) / 2.0 + 0.5, 0.0)),
                       1.0, key="ly_two")
eq("two casters both throw a shadow",
   int(np.count_nonzero(np.diff((umbra(r_sh, [BLOCK, second])[0] < 0.5).astype(int)) > 0)),
   2)
near("...and where they overlap the light does not go negative",
     float(umbra(r_sh, [BLOCK, BLOCK])[0].min()), 0.0, 1e-6)


print("\n  -- collecting casters, and the rig itself --")

CASTER_LAYER = {"id": "ly_c", "threeD": True, "material": {"castsShadows": True}}
got = lights.collect_casters(
    [CASTER_LAYER,
     {"id": "ly_flat", "material": {"castsShadows": True}},              # not 3D
     {"id": "ly_no", "threeD": True, "material": {"castsShadows": False}}],
    lambda lay: (np.ones((8, 8, 4), np.float32), CM4, 1.0))
eq("only 3D layers whose material casts are collected", [c.key for c in got], ["ly_c"])
eq("a caster that fails to rasterise costs a shadow, not a frame",
   lights.collect_casters([CASTER_LAYER], lambda lay: None), [])
eq("...and one that raises does the same",
   lights.collect_casters([CASTER_LAYER],
                          lambda lay: (_ for _ in ()).throw(ValueError("nope"))), [])
eq("the caster count is capped",
   len(lights.collect_casters([dict(CASTER_LAYER, id="c%d" % i) for i in range(40)],
                              lambda lay: (np.ones((8, 8, 4), np.float32), CM4, 1.0))),
   lights.MAX_CASTERS)
eq("a bare (H, W) alpha is a valid caster",
   lights.caster(np.ones((8, 8), np.float32), CM4).alpha.shape, (8, 8))
eq("a caster with a broken matrix is refused", lights.caster(np.ones((8, 8)), np.eye(3)), None)

eq("a disabled light layer is not in the rig",
   lights.rig([dict(light("point"), enabled=False)], 0.0, comp=COMP), None)
eq("a light outside its own time window is not in the rig",
   lights.rig([dict(light("point"), start=2.0, end=4.0)], 0.0, comp=COMP), None)
eq("...and is, inside it",
   len(lights.rig([dict(light("point"), start=2.0, end=4.0)], 3.0, comp=COMP)), 1)
eq("the engine's own visible() rule wins when it is given one",
   lights.rig([light("point")], 0.0, comp=COMP, visible=lambda l: False), None)
eq("the light count is capped",
   len(lights.rig([light("point") for _ in range(40)], 0.0, comp=COMP)),
   lights.MAX_LIGHTS)
eq("a non-light layer is ignored", lights.rig([{"type": "solid"}, light("point")],
                                              0.0, comp=COMP).lights[0].kind, "point")
eq("rig(None) is None", lights.rig(None, 0.0), None)

parented = lights.rig([dict(light("point", (0.0, 0.0, 0.0)), parent="ly_null")], 0.0,
                      comp=COMP,
                      parent_of=lambda lay: np.array([[1, 0, 0, 700.0], [0, 1, 0, 80.0],
                                                      [0, 0, 1, -90.0], [0, 0, 0, 1.0]],
                                                     dtype=np.float64))
eq("a parented light rides its parent's matrix",
   [round(float(v), 3) for v in parented.lights[0].pos], [700.0, 80.0, -90.0])


print("\n  -- keyframes go through the real evaluator --")

anim = {"id": "lt_anim", "type": "light",
        "transform": {"position": [CX, CY, -200.0]},
        "light": {"kind": "point", "falloff": "none",
                  "intensity": {"keys": [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 100.0}]}}}
eq("an intensity keyframe is dark at t=0",
   float(shade(white(), lights.rig([anim], 0.0, comp=COMP))[..., :3].max()), 0.0)
near("...full at t=1", float(shade(white(), lights.rig([anim], 1.0, comp=COMP))[100, 100, 0]),
     1.0, 1e-6)
near("...and interpolated in between",
     float(shade(white(), lights.rig([anim], 0.5, comp=COMP))[100, 100, 0]), 0.5, 1e-3)
eq("interp is the thing doing it",
   float(interp.eval_prop(anim["light"]["intensity"], 0.5, 0.0)), 50.0)
moving = {"id": "lt_mv", "type": "light", "light": {"kind": "point", "falloff": "none"},
          "transform": {"position": {"keys": [{"t": 0.0, "v": [CX, CY, -200.0]},
                                              {"t": 1.0, "v": [CX + 400.0, CY, -200.0]}]}}}
eq("a keyframed position drags the bright spot from the centre to the right edge",
   (int(np.argmax(shade(white(), lights.rig([moving], 0.0, comp=COMP))[100, :, 0])),
    int(np.argmax(shade(white(), lights.rig([moving], 1.0, comp=COMP))[100, :, 0]))),
   (100, N - 1))
anim_mat = {"id": "ly_am", "threeD": True,
            "material": {"ambient": 0, "specular": 0,
                         "diffuse": {"keys": [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 100.0}]}}}
near("a keyframed material option animates too",
     float(shade(white(), lights.rig([anim], 1.0, comp=COMP), anim_mat)[100, 100, 0]),
     1.0, 1e-6)


print("\n  -- hostile input --")


def finite(name, r, layer=LAMBERT, m4=M4):
    out = shade(white(), r, layer, m4=m4)
    eq(name, bool(np.isfinite(out).all() and out.min() >= 0.0 and out.max() <= 1.0), True)


finite("a NaN intensity falls back to the default",
       rig(light("point", (CX, CY, -H), intensity=float("nan"))))
eq("...to exactly the default",
   np.array_equal(shade(white(), rig(light("point", (CX, CY, -H), intensity=float("nan"),
                                           falloff="none"))),
                  shade(white(), rig(light("point", (CX, CY, -H), intensity=100,
                                           falloff="none")))), True)
finite("an infinite position falls back to the default position",
       rig(light("point", (float("inf"), CY, -H))))
finite("a NaN cone angle survives",
       rig(light("spot", (CX, CY, -H), coneAngle=float("nan"))))
finite("a NaN colour survives", rig(light("point", (CX, CY, -H), color=[float("nan"), 0, 0])))
finite("a NaN radius survives",
       rig(light("point", (CX, CY, -H), falloff="inverseSquare", radius=float("nan"))))
finite("a NaN shininess survives", rig(light("point", (CX, CY, -H))),
       mat(specular=100, shininess=float("nan")))
finite("a light sitting exactly ON the surface it lights",
       rig(light("point", (CX, CY, 0.0))))
finite("a light at the layer's own centre pixel, with a falloff",
       rig(light("point", (CX, CY, 0.0), falloff="inverseSquare", radius=100)))
finite("a matrix full of NaN", rig(light("point", (CX, CY, -H))),
       m4=np.full((4, 4), float("nan")))
finite("a collapsed (zero-scale) layer", rig(light("point", (CX, CY, -H))),
       m4=m4_of(scale=(0.0, 0.0, 100.0)))
finite("a garbage kind is read as a point light",
       rig(light("wormhole", (CX, CY, -H))))
finite("a garbage falloff is read as none", rig(light("point", (CX, CY, -H), falloff="???")))
finite("a light with no position at all", rig(light("point")))
finite("a spot aimed at its own position",
       rig(light("spot", (CX, CY, -H), pointOfInterest=[CX, CY, -H])))
finite("pixels that arrive with NaN in them", rig(light("point", (CX, CY, -H))))

_nan_in = np.full((N, N, 4), float("nan"), dtype=np.float32)
_nan_out = shade(_nan_in, rig(light("point", (CX, CY, -H))))
eq("NaN pixels come back as clean colour", bool(np.isfinite(_nan_out[..., :3]).all()), True)
eq("...and a NaN alpha is passed through, because inventing a coverage is not "
   "this module's job", bool(np.isnan(_nan_out[..., 3]).all()), True)
eq("zero intensity contributes NOTHING - bit-identical to the light not being there",
   np.array_equal(shade(white(), rig(light("ambient", intensity=100),
                                     light("point", (CX, CY, -H), intensity=0)),
                        mat(ambient=100, diffuse=100, specular=0)),
                  shade(white(), rig(light("ambient", intensity=100)),
                        mat(ambient=100, diffuse=100, specular=0))), True)
eq("a radius of 0 under the inverse-square law emits nothing, and that is the law",
   float(shade(white(), rig(light("point", (CX, CY, -H), falloff="inverseSquare",
                                  radius=0)))[..., :3].max()), 0.0)
eq("a negative intensity subtracts light rather than adding it",
   float(shade(white(), rig(light("ambient", intensity=100),
                            light("point", (CX, CY, -H), intensity=-100, falloff="none")),
               mat(ambient=100, diffuse=100, specular=0))[100, 100, 0]), 0.0)
eq("a zero render scale does not divide by it",
   bool(np.isfinite(lights.shade(white(), M4, CAM, rig(light("point", (CX, CY, -H))),
                                 LAMBERT, scale=0.0)).all()), True)
eq("a caster with a zero scale is refused",
   lights.caster(np.ones((8, 8), np.float32), CM4, 0.0), None)
finite("a shadow from a caster in the receiver's own plane",
       rig(light("point", (CX, CY, -H), castsShadows=True)))
eq("...and it draws no shadow, because a coplanar caster has none to draw",
   np.array_equal(lit(r_sh, [lights.caster(np.ones((CN, CN, 4), np.float32),
                                           m4_of(position=(CX, CY, 0.0),
                                                 anchor=((CN - 1) / 2.0 + 0.5,
                                                         (CN - 1) / 2.0 + 0.5, 0.0)),
                                           1.0, key="flat")]), lit(r_sh)), True)
# a 202x202 layer rendered at half scale is a 101x101 bitmap, and its anchor is
# still quoted in LAYER pixels - which is the whole reason `scale` is an argument
near("a half-scale render puts the light in the same place on the surface",
     float(lights.shade(np.ones((101, 101, 4), np.float32),
                        m4_of(anchor=(101.0, 101.0, 0.0)), CAM,
                        rig(light("point", (CX, CY, -H), falloff="none")),
                        LAMBERT, scale=0.5)[50, 50, 0]), 1.0, 1e-5)
near("...and reads the same value 50 layer-px out as the full-scale render does",
     float(lights.shade(np.ones((101, 101, 4), np.float32),
                        m4_of(anchor=(101.0, 101.0, 0.0)), CAM,
                        rig(light("point", (CX, CY, -H), falloff="none")),
                        LAMBERT, scale=0.5)[50, 75, 0]),
     H / math.sqrt(50.0 ** 2 + H ** 2), 2e-3)


print("\n  -- 1080p, in milliseconds --")

BIG = np.ones((1080, 1920, 4), dtype=np.float32)
BIGM4 = m4_of(anchor=(960.0, 540.0, 0.0))
BIGC = lights.caster(np.ones((1080, 1920), dtype=np.float32),
                     m4_of(position=(CX, CY, -100.0), anchor=(960.0, 540.0, 0.0)),
                     1.0, key="big")


def ms(fn, reps=3):
    best = 1e9
    for _ in range(reps):
        t0 = time.perf_counter()
        fn()
        best = min(best, (time.perf_counter() - t0) * 1000.0)
    return best


NOSPEC = mat(ambient=100, diffuse=50, specular=0)
FULL = mat(ambient=100, diffuse=50, specular=50, shininess=20)
timings = []
for label, r, layer in [
        ("ambient", rig(light("ambient")), NOSPEC),
        ("parallel", rig(light("parallel", (CX, CY, -900.0))), NOSPEC),
        ("point", rig(light("point", (CX, CY, -900.0))), NOSPEC),
        ("point + spec", rig(light("point", (CX, CY, -900.0))), FULL),
        ("spot (hard)", rig(light("spot", (CX, CY, -900.0), coneFeather=0)), NOSPEC),
        ("spot (feathered)", rig(light("spot", (CX, CY, -900.0), coneFeather=50)), NOSPEC),
        ("parallel + spec", rig(light("parallel", (CX, CY, -900.0))), FULL)]:
    timings.append((label, ms(lambda r=r, layer=layer: lights.shade(
        BIG, BIGM4, CAM, r, layer))))
for label, t in timings:
    print("        %-18s %7.1f ms" % (label, t))

scaling = []
for k in (1, 2, 4, 8):
    r = rig(*[light("point", (CX + 100.0 * i, CY, -900.0)) for i in range(k)])
    scaling.append((k, ms(lambda r=r: lights.shade(BIG, BIGM4, CAM, r, NOSPEC))))
for k, t in scaling:
    print("        %d point light%s   %7.1f ms   (%.1f ms each)"
          % (k, "s" if k > 1 else " ", t, t / k))

r_one = rig(light("point", (CX, CY, -900.0), castsShadows=True))
base_ms = ms(lambda: lights.shade(BIG, BIGM4, CAM, r_one, NOSPEC))
sh1 = ms(lambda: lights.shade(BIG, BIGM4, CAM, r_one, NOSPEC, casters=[BIGC]))
sh2 = ms(lambda: lights.shade(BIG, BIGM4, CAM, r_one, NOSPEC, casters=[BIGC, BIGC]))
print("        shadow pair        %7.1f ms   (1 caster %.1f, 2 casters %.1f, base %.1f)"
      % (sh1 - base_ms, sh1, sh2, base_ms))

slope = (scaling[-1][1] - scaling[0][1]) / 7.0
print("        marginal cost of one more point light: %.1f ms" % slope)
# A guard against a 2x regression, not a spec - the numbers above are the report.
eq("a point light at 1080p stays under 110ms", timings[2][1] < 110.0, True)
eq("light count is linear, not quadratic - the 8th costs what the 2nd did",
   scaling[-1][1] < scaling[0][1] + 8.5 * slope, True)
eq("an ambient light is nearly free", timings[0][1] < timings[2][1], True)
eq("a parallel light is cheaper than a point light", timings[1][1] < timings[2][1], True)


print("\n%d passed, %d failed\n" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
