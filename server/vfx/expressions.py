"""After Effects expressions — a property that computes itself.

WIRING — what the engine owner calls. This file wires itself to nothing:

    from . import expressions               # sits next to interp

    env = expressions.ExprEnv(comp)         # ONCE per frame (or per render)

    # any property read that should honour an expression — the ctx is the
    # FOURTH argument, so nothing about the existing three changes:
    v = interp.eval_prop(prop, t, default, env.bind(layer, "transform.position"))

    # an effect's whole param dict at once; eval_params derives one binding
    # per param from this, so the paths come out as "effects.fx_1.radius":
    p = interp.eval_params(fx.get("params"), t, env.bind(layer, "effects." + fx["id"]))

    for msg in env.take_errors():           # deduped, one line each
        print("vfx: " + msg, file=sys.stderr)

Passing no fourth argument is EXACTLY today's behaviour — the expression is
ignored and the keyframed/constant value comes back. That is also what happens
when an expression fails, so a broken expression costs a warning line, never a
frame. Build one ExprEnv per frame rather than per property: it carries the
compiled-program cache, the cycle set and the error log.

WHY a hand-written AST walker instead of eval(): a comp document arrives over
HTTP and from MCP, so an expression is untrusted input that runs inside the
render process. eval() with a stripped __builtins__ is a well-known escape
(`().__class__.__base__.__subclasses__()`); the walker below never builds a code
object at all. It refuses every node type it does not name, and attribute access
is a dict lookup on our own reference objects — a float, a string, a list and a
function have NO attributes here, so the dunder chain has no first step.
"""
from __future__ import annotations

import ast
import hashlib
import math

try:
    from . import interp
except ImportError:                                    # run as a bare script
    import os
    import sys
    _HERE = os.path.dirname(os.path.abspath(__file__))
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    import interp  # type: ignore

# Budgets. An expression is per-property per-frame, so "slow" here means a
# render that never finishes; every one of these is a refusal, not a clamp.
MAX_SOURCE = 4000        # characters
MAX_NODES = 400          # AST nodes in one program
MAX_STEPS = 20000        # node evaluations in ONE expression
MAX_WORK = 200000        # node evaluations across a whole nest of them. The
                         # depth cap alone is not enough: eight levels that each
                         # read ten linked properties is 10^8 evaluations with
                         # every individual run inside its own budget.
MAX_DEPTH = 8            # how far property links may chain
MAX_STRING = 4096        # cap on string concatenation

_MASK = 0xFFFFFFFFFFFFFFFF


class ExprError(Exception):
    """A refusal or a runtime fault. Always caught at the property boundary."""


_MISSING = object()


# ── deterministic noise ───────────────────────────────────────────────────────
# Python's str hash is salted per process, so a render started twice would
# wiggle differently. Everything random below is seeded through blake2b of
# stable strings and advanced by splitmix64 — same document, same pixels, on
# any machine, in any order.

def _hash64(*parts):
    h = hashlib.blake2b(digest_size=8)
    for p in parts:
        h.update(str(p).encode("utf-8", "replace"))
        h.update(b"\x1f")
    return int.from_bytes(h.digest(), "little")


def _mix64(a, b):
    """splitmix64 — one integer in, a well-distributed one out."""
    z = (a + (b & _MASK) * 0x9E3779B97F4A7C15) & _MASK
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK
    return (z ^ (z >> 31)) & _MASK


class _Rng:
    """xorshift64* — a stream we own, so random() cannot be perturbed by
    anything else in the process that happens to touch the random module."""

    __slots__ = ("s",)

    def __init__(self, seed):
        self.s = (seed & _MASK) or 0x9E3779B97F4A7C15

    def u64(self):
        x = self.s
        x ^= (x >> 12) & _MASK
        x = (x ^ (x << 25)) & _MASK
        x ^= (x >> 27)
        self.s = x
        return (x * 0x2545F4914F6CDD1D) & _MASK

    def unit(self):
        return self.u64() / 18446744073709551616.0

    def gauss(self):
        """Box-Muller, clamped. AE's gaussRandom sits around 0.5 with roughly a
        tenth of its results outside 0..1; sd 0.30 is that shape."""
        u1 = max(1e-12, self.unit())
        u2 = self.unit()
        z = math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)
        return 0.5 + 0.30 * max(-4.0, min(4.0, z))


def _lattice(seed, i):
    """One noise sample at an integer lattice point, in -1..1."""
    return _Rng(_mix64(seed, i)).unit() * 2.0 - 1.0


def noise1(seed, x):
    """Smooth 1-D value noise in -1..1.

    Smoothstep between lattice samples makes the derivative zero at every
    lattice point, so the curve is C1 — wiggle has to look like motion, not
    like a sawtooth. The amplitude bound is exact (|noise| <= 1), which is what
    lets wiggle promise a real ceiling where AE's gaussian one cannot.
    """
    i = math.floor(x)
    f = x - i
    a = _lattice(seed, int(i))
    b = _lattice(seed, int(i) + 1)
    return a + (b - a) * (f * f * (3.0 - 2.0 * f))


# ── value helpers ─────────────────────────────────────────────────────────────

def _is_seq(v):
    return isinstance(v, (list, tuple))


def _f(v, fallback=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return fallback
    return x if math.isfinite(x) else fallback


def _as_list(v):
    return [_f(x) for x in v] if _is_seq(v) else [_f(v)]


def _pad(a, b):
    """Two vectors at a common length, the shorter zero-filled — AE's rule for
    add/sub, and the only sane answer when a 2-D position meets a 3-D one."""
    n = max(len(a), len(b), 1)
    return a + [0.0] * (n - len(a)), b + [0.0] * (n - len(b))


def _zip(a, b, fn):
    """Componentwise, with a SCALAR broadcast to every component.

    Broadcasting rather than padding is the difference between `value * 2`
    doubling a position and halving it: pad-with-zero would make the second
    component times nothing. Two vectors of different length still pad, which is
    AE's rule for add/sub and the only sane answer for a 2-D meeting a 3-D.
    """
    a_seq, b_seq = _is_seq(a), _is_seq(b)
    if not a_seq and not b_seq:
        return fn(_f(a), _f(b))
    if a_seq and b_seq:
        av, bv = _pad(_as_list(a), _as_list(b))
        return [fn(x, y) for x, y in zip(av, bv)]
    if a_seq:
        s = _f(b)
        return [fn(x, s) for x in _as_list(a)]
    s = _f(a)
    return [fn(s, y) for y in _as_list(b)]


def _scalar(v, what="argument"):
    if _is_seq(v):
        raise ExprError(f"{what} must be a number, not an array")
    return _f(v)


def _plainify(v, depth=0):
    """Whatever the sandbox produced, as something the document can hold."""
    if isinstance(v, _Ref):
        v = v.deref()
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        f = float(v)
        if not math.isfinite(f):
            raise ExprError("expression produced a non-finite number")
        return f
    if _is_seq(v):
        if depth > 2:
            raise ExprError("expression produced a nested array")
        return [_plainify(x, depth + 1) for x in v]
    if isinstance(v, str):
        return v
    if v is None:
        raise ExprError("expression produced no value")
    raise ExprError("expression produced a value the document cannot hold")


# ── the reference objects — the ONLY things a dot may land on ─────────────────

class _Ref:
    """Base for every object the sandbox can reach through an attribute.

    A dot on anything that is not one of these is refused before the attribute
    name is even looked at, which is what closes the dunder route.
    """

    def attr(self, name):
        raise ExprError(f"{type(self).__name__} has no {name!r}")

    def call(self, args, kwargs):
        raise ExprError(f"{type(self).__name__} is not callable")

    def deref(self):
        return self


class _Native(_Ref):
    """A python function the sandbox is allowed to call. Wrapping it means a
    bare function value that leaks into the namespace some other way still
    cannot be called — only these can."""

    __slots__ = ("fn", "name")

    def __init__(self, fn, name):
        self.fn = fn
        self.name = name

    def call(self, args, kwargs):
        try:
            return self.fn(*args, **kwargs)
        except ExprError:
            raise
        except TypeError as exc:
            raise ExprError(f"{self.name}(): {exc}") from None
        except ZeroDivisionError:
            raise ExprError(f"{self.name}(): division by zero") from None
        except (ValueError, OverflowError) as exc:
            raise ExprError(f"{self.name}(): {exc}") from None


class _Names(_Ref):
    """A fixed bag of attributes — how Math.PI and Math.sin reach the sandbox."""

    __slots__ = ("label", "items")

    def __init__(self, label, items):
        self.label = label
        self.items = items

    def attr(self, name):
        if name in self.items:
            return self.items[name]
        raise ExprError(f"{self.label} has no {name!r}")


class PropRef(_Ref):
    """Another property, not yet read. Deref happens where a value is needed."""

    __slots__ = ("env", "layer", "path", "prop", "t")

    def __init__(self, env, layer, path, prop, t):
        self.env = env
        self.layer = layer
        self.path = path
        self.prop = prop
        self.t = t

    def deref(self):
        return self.env.read(self.layer, self.path, self.prop, self.t)

    def attr(self, name):
        if name == "value":
            return self.deref()
        if name == "numKeys":
            keys = self.prop.get("keys") if isinstance(self.prop, dict) else None
            return float(len(keys)) if isinstance(keys, list) else 0.0
        if name == "name":
            return self.path.rsplit(".", 1)[-1]
        if name == "velocity":
            return self.env.velocity(self.layer, self.path, self.prop, self.t)
        if name == "speed":
            return self.env.speed(self.layer, self.path, self.prop, self.t)
        if name == "valueAtTime":
            return _Native(lambda t: self.env.read(self.layer, self.path, self.prop, _f(t)),
                           "valueAtTime")
        if name == "velocityAtTime":
            return _Native(lambda t: self.env.velocity(self.layer, self.path, self.prop, _f(t)),
                           "velocityAtTime")
        if name == "speedAtTime":
            return _Native(lambda t: self.env.speed(self.layer, self.path, self.prop, _f(t)),
                           "speedAtTime")
        if name == "keyTime":
            return _Native(lambda i: self.env.key_time(self.prop, i), "keyTime")
        if name == "keyValue":
            return _Native(lambda i: self.env.key_value(self.prop, i), "keyValue")
        raise ExprError(f"property has no {name!r}")


class EffectRef(_Ref):
    """layer.effect("fx_1") — callable with a param name, AE's syntax."""

    __slots__ = ("env", "layer", "fx", "t")

    def __init__(self, env, layer, fx, t):
        self.env = env
        self.layer = layer
        self.fx = fx
        self.t = t

    def call(self, args, kwargs):
        if len(args) != 1 or kwargs:
            raise ExprError('effect(...) takes one parameter name, e.g. ("radius")')
        name = str(args[0])
        params = self.fx.get("params") or {}
        if name not in params:
            raise ExprError(f"effect {self.fx.get('id')!r} has no parameter {name!r}")
        path = "effects.%s.%s" % (self.fx.get("id"), name)
        return PropRef(self.env, self.layer, path, params[name], self.t)

    def attr(self, name):
        if name in ("name", "id"):
            return str(self.fx.get("id") or "")
        if name == "enabled":
            return 1.0 if self.fx.get("enabled", True) else 0.0
        if name == "type":
            return str(self.fx.get("type") or "")
        raise ExprError(f"effect has no {name!r}")


class TransformRef(_Ref):
    """layer.transform — the five animatable rows, under AE's names."""

    _MAP = {"position": "position", "anchorPoint": "anchor", "anchor": "anchor",
            "scale": "scale", "rotation": "rotation", "opacity": "opacity"}

    __slots__ = ("env", "layer", "t")

    def __init__(self, env, layer, t):
        self.env = env
        self.layer = layer
        self.t = t

    def attr(self, name):
        key = self._MAP.get(name)
        if key is None:
            raise ExprError(f"transform has no {name!r}")
        tr = self.layer.get("transform") or {}
        return PropRef(self.env, self.layer, "transform." + key, tr.get(key), self.t)


class LayerRef(_Ref):
    """thisComp.layer("raven"), or thisLayer."""

    __slots__ = ("env", "layer", "t")

    def __init__(self, env, layer, t):
        self.env = env
        self.layer = layer
        self.t = t

    def attr(self, name):
        lay = self.layer
        if name == "transform":
            return TransformRef(self.env, lay, self.t)
        if name in TransformRef._MAP:
            # AE lets you skip .transform — thisComp.layer("x").position works
            return TransformRef(self.env, lay, self.t).attr(name)
        if name == "effect":
            return _Native(lambda which: self._effect(which), "effect")
        if name == "name":
            return str(lay.get("name") or lay.get("id") or "")
        if name == "index":
            return float(self.env.index_of(lay))
        if name == "enabled":
            return 1.0 if lay.get("enabled", True) else 0.0
        if name in ("startTime", "inPoint"):
            # Both are the layer's edge on the COMP timeline. Our document's
            # "inPoint" field means something else — where in the SOURCE the
            # layer starts — and that is sourceInPoint here, so an AE expression
            # reading inPoint gets AE's answer.
            return _f(lay.get("start"), 0.0)
        if name == "sourceInPoint":
            return _f(lay.get("inPoint"), 0.0)
        if name == "outPoint":
            return _f(lay.get("end"), 0.0)
        if name in ("width", "height"):
            # a layer with no bitmap of its own is comp-sized, same rule the
            # engine's _layer_native_size falls back to
            comp = self.env.comp
            if name == "width":
                return _f(lay.get("width"), _f(comp.get("width"), 1920.0))
            return _f(lay.get("height"), _f(comp.get("height"), 1080.0))
        if name == "hasParent":
            return 1.0 if lay.get("parent") else 0.0
        if name == "parent":
            par = self.env.by_id().get(lay.get("parent"))
            if par is None:
                raise ExprError(f"layer {lay.get('name')!r} has no parent")
            return LayerRef(self.env, par, self.t)
        raise ExprError(f"layer has no {name!r}")

    def _effect(self, which):
        stack = self.layer.get("effects") or []
        for fx in stack:
            if isinstance(fx, dict) and str(fx.get("id")) == str(which):
                return EffectRef(self.env, self.layer, fx, self.t)
        for fx in stack:
            if isinstance(fx, dict) and str(fx.get("type")) == str(which):
                return EffectRef(self.env, self.layer, fx, self.t)
        if isinstance(which, (int, float)) and not isinstance(which, bool):
            i = int(which) - 1
            if 0 <= i < len(stack):
                return EffectRef(self.env, self.layer, stack[i], self.t)
        raise ExprError(f"no effect {which!r} on layer {self.layer.get('name')!r}")


class CompRef(_Ref):
    """thisComp."""

    __slots__ = ("env", "t")

    def __init__(self, env, t):
        self.env = env
        self.t = t

    def attr(self, name):
        comp = self.env.comp
        if name == "layer":
            return _Native(self._layer, "layer")
        if name == "width":
            return _f(comp.get("width"), 1920.0)
        if name == "height":
            return _f(comp.get("height"), 1080.0)
        if name == "duration":
            return _f(comp.get("duration"), 0.0)
        if name == "frameDuration":
            return 1.0 / (self.env.fps or 30.0)
        if name == "numLayers":
            return float(len(self.env.layers()))
        if name == "name":
            return str(comp.get("name") or comp.get("slug") or "")
        raise ExprError(f"comp has no {name!r}")

    def _layer(self, which):
        layers = self.env.layers()
        if isinstance(which, (int, float)) and not isinstance(which, bool):
            i = int(which) - 1                      # AE is 1-based, top first
            if 0 <= i < len(layers):
                return LayerRef(self.env, layers[i], self.t)
            raise ExprError(f"no layer at index {which!r}")
        want = str(which)
        for lay in layers:
            if str(lay.get("name") or "") == want:
                return LayerRef(self.env, lay, self.t)
        for lay in layers:
            if str(lay.get("id") or "") == want:
                return LayerRef(self.env, lay, self.t)
        raise ExprError(f"no layer named {want!r}")


# ── the JS ergonomics pre-pass ────────────────────────────────────────────────

def strip_js(src):
    """AE expressions are JavaScript. Two habits survive a paste into Python
    syntax if we let them: // comments and trailing semicolons.

    Consequence, stated plainly: `//` is ALWAYS a comment here, so Python's
    floor division does not exist in expressions. Use floor(a / b).
    """
    out = []
    i, n = 0, len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    lines = []
    for line in "".join(out).splitlines():
        stripped = line.rstrip()
        while stripped.endswith(";"):
            stripped = stripped[:-1].rstrip()
        lines.append(stripped)
    return "\n".join(lines)


# ── the sandbox ───────────────────────────────────────────────────────────────

_EXPR_NODES = (
    ast.Expression, ast.Constant, ast.Name, ast.Load, ast.Tuple, ast.List,
    ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp, ast.Call,
    ast.Attribute, ast.Subscript, ast.Index, ast.Slice, ast.keyword,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.FloorDiv,
    ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
)
_STMT_NODES = (ast.Module, ast.Expr, ast.Assign, ast.If, ast.Pass, ast.Store)
_ALLOWED = _EXPR_NODES + _STMT_NODES

# Everything below is refused by omission; naming the common ones makes the
# error message say WHY instead of just "unsupported".
_NAMED_REFUSALS = {
    "Import": "imports", "ImportFrom": "imports", "Lambda": "lambdas",
    "FunctionDef": "function definitions", "ClassDef": "class definitions",
    "For": "loops", "While": "loops", "Try": "try blocks", "With": "with blocks",
    "ListComp": "comprehensions", "SetComp": "comprehensions",
    "DictComp": "comprehensions", "GeneratorExp": "generators",
    "Yield": "yield", "Await": "await", "Global": "global", "Nonlocal": "nonlocal",
    "Delete": "del", "AugAssign": "augmented assignment", "NamedExpr": "the walrus operator",
    "Starred": "argument unpacking", "JoinedStr": "f-strings", "FormattedValue": "f-strings",
    "Dict": "dict literals", "Set": "set literals",
}

_MAX_POW = 64


class _Program:
    """A parsed, checked expression. Cached — parsing is the expensive half."""

    __slots__ = ("body", "src")

    def __init__(self, src):
        if not isinstance(src, str):
            raise ExprError("expression must be text")
        if len(src) > MAX_SOURCE:
            raise ExprError(f"expression is longer than {MAX_SOURCE} characters")
        cleaned = strip_js(src)
        if not cleaned.strip():
            raise ExprError("expression is empty")
        try:
            tree = ast.parse(cleaned, mode="exec")
        except SyntaxError as exc:
            raise ExprError(f"syntax error: {exc.msg}") from None
        count = 0
        for node in ast.walk(tree):
            count += 1
            if count > MAX_NODES:
                raise ExprError(f"expression has more than {MAX_NODES} nodes")
            kind = type(node).__name__
            if kind in _NAMED_REFUSALS:
                raise ExprError(f"{_NAMED_REFUSALS[kind]} are not allowed in expressions")
            if not isinstance(node, _ALLOWED):
                raise ExprError(f"{kind} is not allowed in expressions")
            if isinstance(node, ast.Name) and node.id.startswith("_"):
                raise ExprError("names starting with _ are not allowed")
            if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
                raise ExprError("attributes starting with _ are not allowed")
            if isinstance(node, ast.Assign):
                for tgt in node.targets:
                    if not isinstance(tgt, ast.Name):
                        raise ExprError("only plain names can be assigned")
            if isinstance(node, ast.Call) and node.keywords:
                for kw in node.keywords:
                    if kw.arg is None:
                        raise ExprError("argument unpacking is not allowed")
        self.body = tree.body
        self.src = src


_PROGRAMS = {}
_PROGRAM_CAP = 512


def compile_expr(src):
    """A checked program for this source, memoised across frames and envs."""
    prog = _PROGRAMS.get(src)
    if prog is None:
        prog = _Program(src)
        if len(_PROGRAMS) >= _PROGRAM_CAP:
            _PROGRAMS.clear()
        _PROGRAMS[src] = prog
    return prog


class _Sandbox:
    """Walks the AST. Every method here either returns a value or raises."""

    __slots__ = ("ev", "env", "vars", "cache", "steps")

    def __init__(self, ev):
        self.ev = ev
        self.env = ev.env
        self.vars = {}
        self.cache = {}
        self.steps = 0

    # -- entry ---------------------------------------------------------------

    def run(self, prog):
        """AE's rule: the value of the LAST bare expression is the result, so an
        expression can set a few variables up first and still be one value."""
        result = _MISSING
        for stmt in prog.body:
            got = self._exec(stmt)
            if got is not None:
                result = got
        if result is _MISSING:
            raise ExprError("expression never produced a value")
        return result

    def _exec(self, stmt):
        self._tick()
        if isinstance(stmt, ast.Expr):
            return self._val(stmt.value)
        if isinstance(stmt, ast.Assign):
            v = self._val(stmt.value)
            for tgt in stmt.targets:
                self.vars[tgt.id] = v
            return None
        if isinstance(stmt, ast.If):
            branch = stmt.body if _truth(self._val(stmt.test)) else stmt.orelse
            out = None
            for sub in branch:
                got = self._exec(sub)
                if got is not None:
                    out = got
            return out
        if isinstance(stmt, ast.Pass):
            return None
        raise ExprError(f"{type(stmt).__name__} is not allowed in expressions")

    # -- helpers -------------------------------------------------------------

    def _tick(self):
        self.steps += 1
        if self.steps > MAX_STEPS:
            raise ExprError(f"expression exceeded {MAX_STEPS} steps")
        env = self.env
        env.work += 1
        if env.work > MAX_WORK:
            raise ExprError(f"this nest of expressions exceeded {MAX_WORK} steps")

    def _val(self, node):
        """A value, with property references resolved. Everything that needs a
        NUMBER goes through here; only Attribute and Call receivers do not, so
        a reference can still be walked before it is read."""
        v = self._eval(node)
        return v.deref() if isinstance(v, _Ref) else v

    # -- expressions ---------------------------------------------------------

    def _eval(self, node):
        self._tick()
        m = getattr(self, "_n_" + type(node).__name__, None)
        if m is None:
            raise ExprError(f"{type(node).__name__} is not allowed in expressions")
        return m(node)

    def _n_Constant(self, node):
        v = node.value
        if isinstance(v, (bool, int, float, str)) or v is None:
            return v
        raise ExprError("only numbers, text and true/false are allowed as literals")

    def _n_Name(self, node):
        name = node.id
        if name in self.vars:
            return self.vars[name]
        if name in self.cache:
            return self.cache[name]
        build = _DYNAMIC.get(name)
        if build is not None:
            v = build(self.ev)
            if name not in _UNCACHED:
                self.cache[name] = v
            return v
        if name in _STATIC:
            return _STATIC[name]
        raise ExprError(f"unknown name {name!r}")

    def _n_List(self, node):
        if len(node.elts) > 16:
            raise ExprError("arrays are limited to 16 components")
        return [self._val(e) for e in node.elts]

    _n_Tuple = _n_List

    def _n_UnaryOp(self, node):
        v = self._val(node.operand)
        if isinstance(node.op, ast.USub):
            return _zip(v, 0.0, lambda a, _b: -a) if _is_seq(v) else -_f(v)
        if isinstance(node.op, ast.UAdd):
            return v
        if isinstance(node.op, ast.Not):
            return not _truth(v)
        raise ExprError("unsupported unary operator")

    def _n_BoolOp(self, node):
        if isinstance(node.op, ast.And):
            out = True
            for v in node.values:
                out = self._val(v)
                if not _truth(out):
                    return out
            return out
        out = False
        for v in node.values:
            out = self._val(v)
            if _truth(out):
                return out
        return out

    def _n_IfExp(self, node):
        return self._val(node.body) if _truth(self._val(node.test)) else self._val(node.orelse)

    def _n_Compare(self, node):
        left = self._val(node.left)
        for op, right_node in zip(node.ops, node.comparators):
            right = self._val(right_node)
            if isinstance(op, ast.Eq):
                ok = _same(left, right)
            elif isinstance(op, ast.NotEq):
                ok = not _same(left, right)
            else:
                a, b = _scalar(left, "comparison"), _scalar(right, "comparison")
                if isinstance(op, ast.Lt):
                    ok = a < b
                elif isinstance(op, ast.LtE):
                    ok = a <= b
                elif isinstance(op, ast.Gt):
                    ok = a > b
                else:
                    ok = a >= b
            if not ok:
                return False
            left = right
        return True

    def _n_BinOp(self, node):
        a = self._val(node.left)
        b = self._val(node.right)
        op = node.op
        if isinstance(op, ast.Add):
            if isinstance(a, str) or isinstance(b, str):
                s = _text(a) + _text(b)
                if len(s) > MAX_STRING:
                    raise ExprError("text got too long")
                return s
            return _zip(a, b, lambda x, y: x + y)
        # Refused rather than repeated: "ab" * 1e9 and [0] * 1e9 are the two
        # memory bombs reachable without a loop.
        if isinstance(a, str) or isinstance(b, str):
            raise ExprError("text supports + only")
        if isinstance(op, ast.Sub):
            return _zip(a, b, lambda x, y: x - y)
        if isinstance(op, ast.Mult):
            return _zip(a, b, lambda x, y: x * y)
        if isinstance(op, (ast.Div, ast.FloorDiv, ast.Mod)):
            def divide(x, y):
                if abs(y) < 1e-12:
                    raise ExprError("division by zero")
                if isinstance(op, ast.Div):
                    return x / y
                if isinstance(op, ast.FloorDiv):
                    return math.floor(x / y)
                return math.fmod(x, y)
            return _zip(a, b, divide)
        if isinstance(op, ast.Pow):
            e = _scalar(b, "exponent")
            if abs(e) > _MAX_POW:
                raise ExprError(f"exponents are limited to +-{_MAX_POW}")
            def power(x, _y=None):
                if x < 0 and e != int(e):
                    raise ExprError("fractional power of a negative number")
                try:
                    return float(x) ** e
                except OverflowError:
                    raise ExprError("number too large") from None
            return [power(x) for x in _as_list(a)] if _is_seq(a) else power(_f(a))
        raise ExprError("unsupported operator")

    def _n_Subscript(self, node):
        target = self._val(node.value)
        if not _is_seq(target):
            raise ExprError("only arrays can be indexed")
        sl = node.slice
        if isinstance(sl, ast.Slice):
            lo = self._val(sl.lower) if sl.lower is not None else None
            hi = self._val(sl.upper) if sl.upper is not None else None
            if sl.step is not None:
                raise ExprError("slice steps are not allowed")
            return list(target)[_opt_int(lo):_opt_int(hi)]
        idx = self._val(sl.value if isinstance(sl, ast.Index) else sl)
        i = int(_scalar(idx, "index"))
        if i < -len(target) or i >= len(target):
            raise ExprError(f"index {i} is outside an array of {len(target)}")
        return target[i]

    def _n_Attribute(self, node):
        obj = self._eval(node.value)
        if not isinstance(obj, _Ref):
            # THE guarantee: numbers, text, arrays and functions have no
            # attributes here, so __class__ / __globals__ have no first step.
            raise ExprError("that value has no properties to read")
        return obj.attr(node.attr)

    def _n_Call(self, node):
        fn = self._eval(node.func)
        if not isinstance(fn, _Ref):
            raise ExprError("that value is not callable")
        if len(node.args) > 8 or len(node.keywords) > 8:
            raise ExprError("too many arguments")
        args = [self._val(a) for a in node.args]
        kwargs = {kw.arg: self._val(kw.value) for kw in node.keywords}
        return fn.call(args, kwargs)


def _opt_int(v):
    return None if v is None else int(_scalar(v, "slice bound"))


def _truth(v):
    if isinstance(v, _Ref):
        v = v.deref()
    if _is_seq(v):
        return len(v) > 0
    if isinstance(v, str):
        return bool(v)
    if v is None:
        return False
    return bool(_f(v))


def _text(v):
    if isinstance(v, str):
        return v
    if _is_seq(v):
        return "[" + ", ".join(_text(x) for x in v) + "]"
    f = _f(v)
    return str(int(f)) if f == int(f) else str(f)


def _same(a, b):
    if _is_seq(a) or _is_seq(b):
        if not (_is_seq(a) and _is_seq(b)) or len(a) != len(b):
            return False
        return all(abs(_f(x) - _f(y)) < 1e-9 for x, y in zip(a, b))
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    return abs(_f(a) - _f(b)) < 1e-9


# ── the AE vocabulary ─────────────────────────────────────────────────────────

def _interp_fraction(u, kind):
    """AE's four interpolators over an already-normalised 0..1 fraction.

    Hermite rather than AE's influence-bezier: the endpoints, the zero tangents
    and monotonicity are exactly right, the curve between them is within a
    couple of percent, and it costs no solver.
    """
    u = 0.0 if u < 0.0 else (1.0 if u > 1.0 else u)
    if kind == "linear":
        return u
    if kind == "ease":                                  # flat at both ends
        return u * u * (3.0 - 2.0 * u)
    if kind == "easeIn":                                # flat leaving tMin
        return u * u * (2.0 - u)
    return u * (1.0 + u - u * u)                        # easeOut: flat at tMax


def _ramp(kind, args, name):
    """linear/ease/easeIn/easeOut share one shape: (t, tMin, tMax, v1, v2) with
    a 3-argument form that means tMin=0, tMax=1."""
    if len(args) == 3:
        t, t0, t1, v1, v2 = args[0], 0.0, 1.0, args[1], args[2]
    elif len(args) == 5:
        t, t0, t1, v1, v2 = args
    else:
        raise ExprError(f"{name}() takes (t, v1, v2) or (t, tMin, tMax, v1, v2)")
    t = _scalar(t, "t")
    t0, t1 = _scalar(t0, "tMin"), _scalar(t1, "tMax")
    if t1 == t0:
        return v2 if t >= t1 else v1
    if t1 < t0:                                        # a reversed range still ramps
        t0, t1, v1, v2 = t1, t0, v2, v1
    u = (t - t0) / (t1 - t0)
    if u <= 0.0:
        return _copy(v1)
    if u >= 1.0:
        return _copy(v2)
    return _zip(v1, v2, lambda a, b: a + (b - a) * _interp_fraction(u, kind))


def _copy(v):
    return [_f(x) for x in v] if _is_seq(v) else _f(v)


def _build_static():
    """The half of the vocabulary that does not depend on which property is
    being evaluated. Built ONCE at import — an expression is evaluated per
    property per frame, so building fifty closures each time was measurably the
    most expensive thing in the whole path."""

    def length(a, b=None):
        v = _as_list(a) if b is None else _zip(b, a, lambda x, y: x - y)
        return math.sqrt(sum(x * x for x in _as_list(v)))

    def normalize(a):
        v = _as_list(a)
        n = math.sqrt(sum(x * x for x in v))
        if n < 1e-12:
            raise ExprError("cannot normalize a zero-length vector")
        return [x / n for x in v]

    def cross(a, b):
        av, bv = _pad(_as_list(a), _as_list(b))
        if len(av) == 2:
            return av[0] * bv[1] - av[1] * bv[0]        # the z of a 2-D cross
        if len(av) != 3:
            raise ExprError("cross() needs 2- or 3-component vectors")
        return [av[1] * bv[2] - av[2] * bv[1],
                av[2] * bv[0] - av[0] * bv[2],
                av[0] * bv[1] - av[1] * bv[0]]

    def clamp(v, lo, hi):
        return _zip(_zip(v, lo, max), hi, min)

    def divide(a, b):
        def one(x, y):
            if abs(y) < 1e-12:
                raise ExprError("division by zero")
            return x / y
        return _zip(a, b, one)

    def scalar_fn(fn, name):
        return _Native(lambda x: fn(_scalar(x, name)), name)

    math_names = {
        "PI": math.pi, "E": math.e,
        "abs": _Native(lambda x: abs(_scalar(x, "abs")), "abs"),
        "floor": scalar_fn(lambda x: float(math.floor(x)), "floor"),
        "ceil": scalar_fn(lambda x: float(math.ceil(x)), "ceil"),
        "round": scalar_fn(lambda x: float(round(x)), "round"),
        "sqrt": scalar_fn(lambda x: math.sqrt(abs(x)), "sqrt"),
        "sin": scalar_fn(math.sin, "sin"), "cos": scalar_fn(math.cos, "cos"),
        "tan": scalar_fn(math.tan, "tan"), "asin": scalar_fn(math.asin, "asin"),
        "acos": scalar_fn(math.acos, "acos"), "atan": scalar_fn(math.atan, "atan"),
        "exp": scalar_fn(lambda x: math.exp(min(700.0, x)), "exp"),
        "log": scalar_fn(lambda x: math.log(max(1e-300, x)), "log"),
        "atan2": _Native(lambda y, x: math.atan2(_scalar(y, "y"), _scalar(x, "x")), "atan2"),
        "pow": _Native(lambda x, y: _scalar(x, "x") ** max(-_MAX_POW, min(_MAX_POW, _scalar(y, "y"))), "pow"),
        "min": _Native(lambda a, b: _zip(a, b, min), "min"),
        "max": _Native(lambda a, b: _zip(a, b, max), "max"),
    }

    ns = {
        # AE writes these as JavaScript, and people paste JavaScript
        "true": True, "false": False, "null": None,

        "Math": _Names("Math", math_names),

        "linear": _Native(lambda *a: _ramp("linear", a, "linear"), "linear"),
        "ease": _Native(lambda *a: _ramp("ease", a, "ease"), "ease"),
        "easeIn": _Native(lambda *a: _ramp("easeIn", a, "easeIn"), "easeIn"),
        "easeOut": _Native(lambda *a: _ramp("easeOut", a, "easeOut"), "easeOut"),

        "add": _Native(lambda a, b: _zip(a, b, lambda x, y: x + y), "add"),
        "sub": _Native(lambda a, b: _zip(a, b, lambda x, y: x - y), "sub"),
        "mul": _Native(lambda a, b: _zip(a, b, lambda x, y: x * y), "mul"),
        "div": _Native(divide, "div"),
        "length": _Native(length, "length"),
        "normalize": _Native(normalize, "normalize"),
        "dot": _Native(lambda a, b: float(sum(x * y for x, y in zip(*_pad(_as_list(a), _as_list(b))))), "dot"),
        "cross": _Native(cross, "cross"),
        "clamp": _Native(clamp, "clamp"),

        "degreesToRadians": _Native(lambda d: _zip(d, 0.0, lambda x, _y: math.radians(x))
                                    if _is_seq(d) else math.radians(_scalar(d, "degrees")),
                                    "degreesToRadians"),
        "radiansToDegrees": _Native(lambda r: _zip(r, 0.0, lambda x, _y: math.degrees(x))
                                    if _is_seq(r) else math.degrees(_scalar(r, "radians")),
                                    "radiansToDegrees"),
    }
    ns.update(math_names)                              # bare sin(), PI, min/max
    return ns


_STATIC = _build_static()


# The other half: names that only mean something for a particular property at a
# particular instant. Built on demand — an expression that says `value + 3`
# should construct two objects, not fifty.

def _wiggle(ev):
    def wiggle(freq, amp, octaves=1, amp_mult=0.5, t=None):
        tt = ev.time() if t is None else _scalar(t, "t")
        return ev.wiggle(ev.base(tt), _scalar(freq, "freq"), amp,
                         int(_scalar(octaves, "octaves")), _scalar(amp_mult, "amp_mult"), tt)
    return _Native(wiggle, "wiggle")


def _seed_random(ev):
    def seed_random(seed, timeless=False):
        ev.seed_random(_scalar(seed, "seed"), _truth(timeless))
        return None                                    # AE's seedRandom sets, it does not return
    return _Native(seed_random, "seedRandom")


def _time_to_frames(ev):
    def time_to_frames(t=None, fps=None, is_duration=False):
        tt = ev.time() if t is None else _scalar(t, "t")
        rate = ev.env.fps if fps is None else _scalar(fps, "fps")
        f = tt * (rate or 30.0)
        return float(round(f)) if _truth(is_duration) else float(math.floor(f + 1e-9))
    return _Native(time_to_frames, "timeToFrames")


def _frames_to_time(ev):
    def frames_to_time(frames, fps=None):
        rate = ev.env.fps if fps is None else _scalar(fps, "fps")
        return _scalar(frames, "frames") / (rate or 30.0)
    return _Native(frames_to_time, "framesToTime")


def _posterize_time(ev):
    def posterize_time(fps):
        rate = _scalar(fps, "fps")
        if rate <= 0:
            raise ExprError("posterizeTime() needs a positive fps")
        ev.posterize = rate
        return ev.time()
    return _Native(posterize_time, "posterizeTime")


_DYNAMIC = {
    "time": lambda ev: ev.time(),
    "value": lambda ev: ev.base(ev.time()),
    "index": lambda ev: float(ev.env.index_of(ev.layer)) if ev.layer is not None else 0.0,
    "thisLayer": lambda ev: LayerRef(ev.env, ev.layer, ev.t) if ev.layer is not None else None,
    "thisComp": lambda ev: CompRef(ev.env, ev.t),
    "thisProperty": lambda ev: PropRef(ev.env, ev.layer, ev.path, ev.prop, ev.t),

    "wiggle": _wiggle,
    "random": lambda ev: _Native(lambda *a: ev.random(a, gauss=False), "random"),
    "gaussRandom": lambda ev: _Native(lambda *a: ev.random(a, gauss=True), "gaussRandom"),
    "seedRandom": _seed_random,

    "loopOut": lambda ev: _Native(
        lambda kind="cycle", num=0: ev.loop(str(kind), int(_scalar(num, "numKeyframes")), True),
        "loopOut"),
    "loopIn": lambda ev: _Native(
        lambda kind="cycle", num=0: ev.loop(str(kind), int(_scalar(num, "numKeyframes")), False),
        "loopIn"),

    "valueAtTime": lambda ev: _Native(lambda t: ev.base(_scalar(t, "t")), "valueAtTime"),
    "velocity": lambda ev: ev.own_velocity(ev.time()),
    "speed": lambda ev: ev.own_speed(ev.time()),
    "velocityAtTime": lambda ev: _Native(lambda t: ev.own_velocity(_scalar(t, "t")),
                                         "velocityAtTime"),
    "speedAtTime": lambda ev: _Native(lambda t: ev.own_speed(_scalar(t, "t")), "speedAtTime"),
    "numKeys": lambda ev: float(len(interp.sorted_keys(ev.prop))),

    "timeToFrames": _time_to_frames,
    "framesToTime": _frames_to_time,
    "posterizeTime": _posterize_time,
}

# posterizeTime() moves the clock mid-expression, so anything derived from the
# clock has to be re-read rather than remembered.
_UNCACHED = frozenset(("time", "value", "velocity", "speed"))


# ── one evaluation ────────────────────────────────────────────────────────────

class _Eval:
    """The state of a single expression run: which property, at what time, with
    what seed. Short-lived — one per property per frame."""

    __slots__ = ("env", "layer", "path", "prop", "t", "default",
                 "posterize", "seed_value", "timeless", "draws", "_base")

    def __init__(self, env, layer, path, prop, t, default):
        self.env = env
        self.layer = layer
        self.path = path
        self.prop = prop
        self.t = t
        self.default = default
        self.posterize = 0.0
        self.seed_value = 0.0
        self.timeless = False
        self.draws = 0
        self._base = {}

    def time(self):
        if self.posterize > 0.0:
            return math.floor(self.t * self.posterize + 1e-9) / self.posterize
        return self.t

    def base(self, t):
        """The property's own keyframed/constant value — the expression's
        `value`. Evaluated WITHOUT the expression, which is what makes
        `value + wiggle(...)` finite rather than self-referential."""
        key = round(t, 9)
        if key not in self._base:
            if len(self._base) > 64:
                self._base.clear()
            self._base[key] = interp.eval_prop(self.prop, t, self.default)
        return self._base[key]

    # -- randomness ----------------------------------------------------------

    def seed_random(self, seed, timeless):
        self.seed_value = seed
        self.timeless = bool(timeless)
        self.draws = 0

    def _stream_seed(self):
        frame = 0 if self.timeless else int(math.floor(self.t * (self.env.fps or 30.0) + 1e-6))
        return _hash64(self.env.seed, self.layer.get("id") if self.layer else "-",
                       self.path, "random", self.seed_value, frame)

    def random(self, args, gauss=False):
        rng = _Rng(_mix64(self._stream_seed(), self.draws))
        self.draws += 1
        draw = rng.gauss if gauss else rng.unit
        if not args:
            return draw()
        if len(args) == 1:
            hi = args[0]
            return _zip(hi, 0.0, lambda h, _z: draw() * h) if _is_seq(hi) \
                else draw() * _scalar(hi, "max")
        lo, hi = args[0], args[1]
        return _zip(lo, hi, lambda a, b: a + draw() * (b - a))

    def wiggle(self, base, freq, amp, octaves, amp_mult, t):
        octaves = max(1, min(8, octaves))
        comps = _as_list(base)
        amps = _as_list(amp)
        if len(amps) < len(comps):
            amps = amps + [amps[-1]] * (len(comps) - len(amps))
        root = _hash64(self.env.seed, self.layer.get("id") if self.layer else "-",
                       self.path, "wiggle", self.seed_value)
        out = []
        for c, (v, a) in enumerate(zip(comps, amps)):
            n, gain, f = 0.0, a, freq
            for o in range(octaves):
                n += gain * noise1(_mix64(root, c * 131 + o), t * f)
                gain *= amp_mult
                f *= 2.0
            out.append(v + n)
        return out if _is_seq(base) else out[0]

    # -- loops ---------------------------------------------------------------

    def loop(self, kind, num, out=True):
        keys = interp.sorted_keys(self.prop)
        if len(keys) < 2:
            return self.base(self.time())
        kind = kind.strip().lower()
        t = self.time()
        num = max(0, num)
        if out:
            j = len(keys) - 1
            i = 0 if num <= 0 else max(0, j - num)
            t0, t1 = interp.key_time(keys[i]), interp.key_time(keys[j])
            if t <= t1:
                return self.base(t)
        else:
            i = 0
            j = len(keys) - 1 if num <= 0 else min(len(keys) - 1, num)
            t0, t1 = interp.key_time(keys[i]), interp.key_time(keys[j])
            if t >= t0:
                return self.base(t)
        span = t1 - t0
        if span <= 1e-9:
            return self.base(t)

        if kind == "continue":
            # One-sided on purpose: a central difference straddling the last key
            # samples the flat hold beyond it and halves the outgoing speed, so
            # "continue" would leave at the wrong angle.
            edge = t1 if out else t0
            h = min(span, 1.0 / ((self.env.fps or 30.0) * 4.0))
            inside = self.base(edge - h) if out else self.base(edge + h)
            vel = _zip(self.base(edge), inside, lambda v, w: (v - w) / h)
            return _zip(self.base(edge), vel,
                        lambda v, d: v + d * ((t - edge) if out else (edge - t)))

        phase = math.fmod(t - t0, span)
        if phase < 0:
            phase += span
        cycles = math.floor((t - t0) / span)
        if kind == "pingpong":
            tt = t1 - phase if cycles % 2 else t0 + phase
            return self.base(tt)
        if kind == "offset":
            delta = _zip(self.base(t1), self.base(t0), lambda a, b: a - b)
            return _zip(self.base(t0 + phase), delta, lambda v, d: v + d * cycles)
        return self.base(t0 + phase)                    # "cycle", and the default

    # -- derivatives of our own property -------------------------------------

    def own_velocity(self, t):
        h = 1.0 / ((self.env.fps or 30.0) * 8.0)
        a, b = self.base(t - h), self.base(t + h)
        return _zip(b, a, lambda x, y: (x - y) / (2.0 * h))

    def own_speed(self, t):
        v = self.own_velocity(t)
        return math.sqrt(sum(x * x for x in _as_list(v)))


# ── the environment the engine holds ──────────────────────────────────────────

class _Binding:
    """One (layer, property path). This is what interp.eval_prop receives as its
    optional fourth argument; it needs exactly one method."""

    __slots__ = ("env", "layer", "path")

    def __init__(self, env, layer, path):
        self.env = env
        self.layer = layer
        self.path = path

    def at(self, name):
        """The binding for a child of this one — how eval_params names params."""
        return self.env.bind(self.layer, self.path + "." + str(name))

    def eval_expression(self, prop, t, default=None):
        return self.env.evaluate(self.layer, self.path, prop, t, default)


class ExprEnv:
    """One comp, for as long as a render lasts.

    Holds the cycle set, the depth counter, the work budget, the error log and
    the layer index — all of which have to be shared across every property in a
    frame, which is why this is per-frame state and not per-property.
    """

    def __init__(self, comp, seed=0, max_depth=MAX_DEPTH, fps=None):
        self.comp = comp if isinstance(comp, dict) else {}
        self.seed = seed
        self.max_depth = max(1, min(32, int(max_depth)))
        self.fps = _f(fps, 0.0) or _f(self.comp.get("fps"), 30.0) or 30.0
        self.errors = []
        self.work = 0
        self._seen_errors = set()
        self._active = set()
        self._depth = 0
        self._bindings = {}
        self._by_id = None
        self._layers = None
        self._index = None

    # -- document views ------------------------------------------------------

    def layers(self):
        if self._layers is None:
            self._layers = [l for l in (self.comp.get("layers") or []) if isinstance(l, dict)]
        return self._layers

    def by_id(self):
        if self._by_id is None:
            self._by_id = {l.get("id"): l for l in self.layers() if l.get("id")}
        return self._by_id

    def index_of(self, layer):
        """AE's 1-based index, top layer first — the same order as layers[]."""
        if not isinstance(layer, dict):
            return 0
        if self._index is None:
            self._index = {id(l): i + 1 for i, l in enumerate(self.layers())}
        return self._index.get(id(layer), 0)

    def bind(self, layer, path):
        lid = layer.get("id") if isinstance(layer, dict) else "__comp__"
        key = (lid, path)
        b = self._bindings.get(key)
        if b is None:
            b = _Binding(self, layer, path)
            self._bindings[key] = b
        return b

    # -- errors --------------------------------------------------------------

    def note(self, msg):
        """One line per DISTINCT problem: a broken expression on a 240-frame
        render would otherwise write 240 identical lines to stderr."""
        if msg not in self._seen_errors:
            self._seen_errors.add(msg)
            self.errors.append(msg)

    def take_errors(self):
        out = self.errors
        self.errors = []
        return out

    # -- evaluation ----------------------------------------------------------

    def evaluate(self, layer, path, prop, t, default=None):
        """Run one property's expression, or explain why we did not."""
        base = lambda: interp.eval_prop(prop, t, default)          # noqa: E731
        src = prop.get("expr") if isinstance(prop, dict) else None
        if not src:
            return base()
        lid = layer.get("id") if isinstance(layer, dict) else "__comp__"
        where = f"{lid}.{path}"
        key = (lid, path)
        if key in self._active:
            # ASCII on purpose: this goes to stderr on a console whose codepage
            # we do not choose.
            self.note(f"expression cycle at {where}: it reads a property that reads it back")
            return base()
        if self._depth >= self.max_depth:
            self.note(f"expression at {where} nests deeper than {self.max_depth} properties")
            return base()

        if self._depth == 0:
            # The budget is per outermost property, not per frame — a comp with
            # forty expressions must not run out because it is the fortieth.
            self.work = 0
        self._active.add(key)
        self._depth += 1
        try:
            prog = compile_expr(src)
            ev = _Eval(self, layer if isinstance(layer, dict) else None, path, prop, _f(t), default)
            return _plainify(_Sandbox(ev).run(prog))
        except ExprError as exc:
            self.note(f"expression at {where}: {exc}")
            return base()
        except RecursionError:
            self.note(f"expression at {where}: too deeply nested")
            return base()
        except Exception as exc:                                   # noqa: BLE001
            # A render must not die for a typo in a property field.
            self.note(f"expression at {where}: {type(exc).__name__}: {exc}")
            return base()
        finally:
            self._depth -= 1
            self._active.discard(key)

    # -- what PropRef needs --------------------------------------------------

    def read(self, layer, path, prop, t):
        return interp.eval_prop(prop, t, None, self.bind(layer, path))

    def velocity(self, layer, path, prop, t):
        h = 1.0 / ((self.fps or 30.0) * 8.0)
        a = self.read(layer, path, prop, t - h)
        b = self.read(layer, path, prop, t + h)
        return _zip(b, a, lambda x, y: (x - y) / (2.0 * h))

    def speed(self, layer, path, prop, t):
        return math.sqrt(sum(x * x for x in _as_list(self.velocity(layer, path, prop, t))))

    def key_time(self, prop, i):
        keys = interp.sorted_keys(prop)
        idx = int(_scalar(i, "index")) - 1
        if not keys or idx < 0 or idx >= len(keys):
            raise ExprError(f"no keyframe {i!r}")
        return interp.key_time(keys[idx])

    def key_value(self, prop, i):
        keys = interp.sorted_keys(prop)
        idx = int(_scalar(i, "index")) - 1
        if not keys or idx < 0 or idx >= len(keys):
            raise ExprError(f"no keyframe {i!r}")
        return _copy(keys[idx].get("v"))


def bind(comp, layer, path, seed=0):
    """A one-off binding for callers that do not keep an ExprEnv around.

    Convenient, but it builds a fresh env per call — the render path should hold
    one ExprEnv per frame instead, or the cycle guard and the error log only
    ever see one property at a time.
    """
    return ExprEnv(comp, seed=seed).bind(layer, path)


def has_expression(prop):
    return isinstance(prop, dict) and bool(prop.get("expr"))
