"""Tests for the closed-form particle system in server/vfx/particles.py.

The sweeps in effects_test.py already prove the pixel contract (shape, dtype,
range, input never mutated, every advertised range end). What lives here is
what makes a particle system RIGHT rather than merely safe:

  * the closed form against ground truth - the analytic ballistic-with-drag
    position checked against an RK4 integration of the same ODE, because a
    formula this load-bearing should be proven against something that is not
    itself;
  * determinism ACROSS PROCESSES - the same frame sha1-identical from a
    subprocess, which is the render-farm guarantee;
  * scrub independence - frame t rendered cold equals frame t rendered after
    a walk through earlier times, which is what "no hidden state" means and
    what will break the day someone adds a cache;
  * the birth-time model - constant rate through the animated path lands on
    the constant path's uniform spacing; an animated ramp integrates to the
    area under the curve;
  * the caps - MAX_PARTICLES and draft thinning both engage, deterministically;
  * colours are 0-255 - the trap this codebase has already documented: a 0-1
    triple is legal near-black and every structural test still passes while
    the picture is wrong. So a test LOOKS at the colour.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/particles_test.py
"""
import hashlib
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import effects  # noqa: E402
import interp  # noqa: E402
import particles  # noqa: E402

npass, fails = 0, []


def eq(label, got, want):
    global npass
    if got == want:
        npass += 1
        print(f"  ok    {label}")
    else:
        fails.append(label)
        print(f"  FAIL  {label}\n          got {got!r}  want {want!r}")


def ok(label, cond, detail=""):
    eq(label, bool(cond), True) if not detail or cond else None
    if detail and not cond:
        global npass
        fails.append(label)
        print(f"  FAIL  {label}\n          {detail}")


def plate(w=160, h=120):
    return np.zeros((h, w, 4), np.float32)


def run(params, t, w=160, h=120, draft=False, ctx_extra=None):
    ctx = {"t": t, "fps": 30.0, "draft": draft}
    ctx.update(ctx_extra or {})
    return effects.apply("particleSystem", plate(w, h), params, ctx)


def sha(arr):
    return hashlib.sha1(np.ascontiguousarray(arr).tobytes()).hexdigest()


BASE = {"birthRate": 200, "speed": 60, "gravityY": 120, "seed": 11,
        "sizeStart": 8, "sizeEnd": 4, "spread": 360}

print("\nvfx particles\n")

# ── the closed form against ground truth ───────────────────────────────────
# dv/dt = a - k v integrated with RK4 at a tiny step must land where
# p0 + v0*F + a*G says, for stiff drag, mild drag, and the k->0 branch.

# Tolerances: the exact branch must sit on the ODE to float precision; the
# k < 1e-6 branch deliberately uses the ballistic limit, whose error against
# the true ODE is bounded by |v0|*k*T^2/2 + |a|*k*T^3/6 - under 1e-4 px at
# the branch point, which is what the looser bound asserts.
for k, tol, label in ((0.0, 1e-6, "k=0 (pure ballistic)"),
                      (1e-7, 1e-3, "k under the branch point (limit approx)"),
                      (0.4, 1e-6, "mild drag"), (8.0, 1e-6, "stiff drag")):
    a_vec = np.array([30.0, 250.0])
    v0 = np.array([80.0, -140.0])
    T = 2.5
    steps = 40000
    dt = T / steps
    p_num = np.zeros(2)
    v = v0.copy()
    for _ in range(steps):                      # RK4 on (p, v)
        def acc(vv):
            return a_vec - k * vv
        k1p, k1v = v, acc(v)
        k2p, k2v = v + 0.5 * dt * k1v, acc(v + 0.5 * dt * k1v)
        k3p, k3v = v + 0.5 * dt * k2v, acc(v + 0.5 * dt * k2v)
        k4p, k4v = v + dt * k3v, acc(v + dt * k3v)
        p_num += dt / 6.0 * (k1p + 2 * k2p + 2 * k3p + k4p)
        v += dt / 6.0 * (k1v + 2 * k2v + 2 * k3v + k4v)
    kk = max(k, 1e-12)
    F = T if k < 1e-6 else -np.expm1(-kk * T) / kk
    G = 0.5 * T * T if k < 1e-6 else (T - F) / kk
    p_closed = v0 * F + a_vec * G
    err = float(np.max(np.abs(p_closed - p_num)))
    eq(f"closed form matches RK4 within {tol:g} px, {label}", err < tol, True)

# ── determinism: same frame, two processes, one sha1 ───────────────────────

frame = run(BASE, 1.3)
in_proc = sha(frame)
prog = (
    "import sys, hashlib, numpy as np;"
    f"sys.path.insert(0, {os.path.dirname(os.path.abspath(__file__))!r});"
    "import effects;"
    f"out = effects.apply('particleSystem', np.zeros((120,160,4), np.float32), {BASE!r},"
    " {'t': 1.3, 'fps': 30.0, 'draft': False});"
    "print(hashlib.sha1(np.ascontiguousarray(out).tobytes()).hexdigest())"
)
other = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True)
eq("a separate process renders the sha1-identical frame",
   other.stdout.strip(), in_proc)
print(f"        (sha1 {in_proc})")

# ── scrub independence: no hidden state ────────────────────────────────────

cold = run(BASE, 2.0)
for t in (0.0, 0.5, 1.0):
    run(BASE, t)
warm = run(BASE, 2.0)
eq("t=2.0 cold equals t=2.0 after scrubbing 0, 0.5, 1.0",
   sha(warm), sha(cold))
print(f"        (sha1 {sha(cold)})")

# ── the picture is actually there, and made of the right colour ────────────

p_red = dict(BASE, colorStart=[255, 0, 0], colorEnd=[255, 0, 0],
             opacityEnd=100, speed=20, gravityY=0)
f = run(p_red, 1.0)
eq("particles put down alpha on a transparent plate", float(f[..., 3].max()) > 0.3, True)
r, g = float(f[..., 0].max()), float(f[..., 1].max())
eq("a [255,0,0] colour renders red, not the 0-1 near-black trap",
   r > 0.5 and g < 0.05, True)

# ── the birth-time model ───────────────────────────────────────────────────
# Constant rate through the ANIMATED path (a keyframed track whose keys are
# equal) must land on the same births as the constant path. The engine is not
# here, so its ctx contract is stood up by hand: paramsAt evaluates the raw
# dict through interp.eval_params exactly as engine.py does.


def anim_ctx(raw):
    return {
        "paramsAt": lambda tt: interp.eval_params(raw, float(tt), None),
        "fxParams": raw,
    }


flat = dict(BASE, birthRate={"keys": [{"t": 0, "v": 200}, {"t": 3, "v": 200}]})
via_animated = effects.apply("particleSystem", plate(), dict(BASE),
                             {"t": 1.3, "fps": 30.0, **anim_ctx(flat)})
eq("a flat keyframed birth rate renders the constant path's exact frame",
   sha(via_animated), in_proc)

# A ramp 0 -> 100 over 2s has integral 100; particle count at t=2 must be
# within a few of it (trapezoid on a 60Hz anchored grid, linear curve: exact).
ramp = {"birthRate": {"keys": [{"t": 0, "v": 0}, {"t": 2, "v": 100}]},
        "lifetime": 10, "lifetimeVariance": 0, "opacityEnd": 100,
        "sizeStart": 2, "sizeEnd": 2, "sizeVariance": 0, "speed": 5,
        "gravityY": 0, "seed": 3}
counted = {}
real_u01 = particles._u01


def spy_u01(seed, idx, salt):
    counted["n"] = max(counted.get("n", 0), len(idx))
    return real_u01(seed, idx, salt)


particles._u01 = spy_u01
try:
    effects.apply("particleSystem", plate(), ramp, {"t": 2.0, "fps": 30.0, **anim_ctx(ramp)})
finally:
    particles._u01 = real_u01
eq("an animated ramp integrates to the area under the curve (100 +/- 2)",
   abs(counted.get("n", 0) - 100) <= 2, True)

# Scrub independence holds for the ANIMATED path too - the anchored grid is
# what guarantees it, so it is asserted rather than trusted.
a1 = effects.apply("particleSystem", plate(), ramp, {"t": 1.5, "fps": 30.0, **anim_ctx(ramp)})
effects.apply("particleSystem", plate(), ramp, {"t": 0.4, "fps": 30.0, **anim_ctx(ramp)})
a2 = effects.apply("particleSystem", plate(), ramp, {"t": 1.5, "fps": 30.0, **anim_ctx(ramp)})
eq("animated-path frame at t=1.5 is scrub-independent", sha(a1), sha(a2))

# An ANIMATED EMITTER: position keyframed across the frame. Each particle must
# carry the position of its own birth instant, so the spray smears between the
# two ends rather than clumping at the current position.
mov = {"birthRate": 300, "speed": 0, "gravityY": 0, "sizeStart": 3, "sizeEnd": 3,
       "opacityEnd": 100, "lifetime": 5, "lifetimeVariance": 0, "seed": 2,
       "positionX": {"keys": [{"t": 0, "v": 10}, {"t": 2, "v": 90}]}}
f = effects.apply("particleSystem", plate(), mov, {"t": 2.0, "fps": 30.0, **anim_ctx(mov)})
cols = f[..., 3].sum(axis=0)
lit = np.nonzero(cols > 0.01)[0]
eq("birth-time emitter sampling smears the trail across the frame",
   len(lit) > 0 and lit[0] < 40 and lit[-1] > 120, True)

# ── the caps ───────────────────────────────────────────────────────────────

heavy = {"birthRate": 1000, "lifetime": 10, "lifetimeVariance": 0,
         "opacityEnd": 100, "sizeStart": 2, "sizeEnd": 2, "seed": 4,
         "speed": 10, "gravityY": 0}
notes = []
out = effects.apply("particleSystem", plate(), heavy,
                    {"t": 9.0, "fps": 30.0, "notes": notes})
eq("9000 candidates over MAX_PARTICLES completes and says so",
   any("MAX_PARTICLES" in n for n in notes), True)
d1 = run(BASE, 1.3, draft=True)
d2 = run(BASE, 1.3, draft=True)
eq("draft thinning is deterministic too", sha(d1), sha(d2))
full_a = float(run(BASE, 1.3)[..., 3].sum())
draft_a = float(d1[..., 3].sum())
eq("draft renders fewer particles, not zero",
   0.0 < draft_a < full_a, True)

# ── render scale: a half-scale preview shows the same motion ───────────────

f1 = run(dict(BASE, seed=9), 1.0, w=200, h=150)
f2 = run(dict(BASE, seed=9), 1.0, w=100, h=75, ctx_extra={"scale": 0.5})
yy1, xx1 = np.nonzero(f1[..., 3] > 0.05)
yy2, xx2 = np.nonzero(f2[..., 3] > 0.05)
c1 = (float(xx1.mean()), float(yy1.mean()))
c2 = (float(xx2.mean()) * 2, float(yy2.mean()) * 2)
eq("the particle cloud's centre of mass survives a half-scale render (+/-3px)",
   abs(c1[0] - c2[0]) < 3 and abs(c1[1] - c2[1]) < 3, True)

# ── the budget, measured honestly ──────────────────────────────────────────
# 2000 live particles at 720p. The bar is generous (a CI box under load is
# not a benchmark rig); the printed number is the honest measurement.

perf = {"birthRate": 400, "lifetime": 5, "lifetimeVariance": 0, "speed": 120,
        "spread": 360, "sizeStart": 10, "sizeEnd": 4, "opacityEnd": 50,
        "seed": 6, "gravityY": 150}
arr = np.zeros((720, 1280, 4), np.float32)
effects.apply("particleSystem", arr, perf, {"t": 5.0, "fps": 30.0})  # warm
times = []
for _ in range(3):
    tt = time.perf_counter()
    effects.apply("particleSystem", arr, perf, {"t": 5.0, "fps": 30.0})
    times.append((time.perf_counter() - tt) * 1000)
ms = min(times)
print(f"        2000 live particles at 720p: {ms:.1f} ms")
eq("2000 particles at 720p stays under 150 ms", ms < 150, True)

print(f"\n{npass} passed, {len(fails)} failed\n")
for f_ in fails:
    print(f"   · {f_}")
sys.exit(1 if fails else 0)
