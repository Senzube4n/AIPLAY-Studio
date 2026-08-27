"""DAW — the instrument stage. The real palette behind engine.py's notes.

┌─ SEAM CONTRACT (binding on wt_dawinst / wt_dawrack / wt_dawrec) ──────────┐
│ Per-track render = INSTRUMENT STAGE then CHAIN STAGE.                     │
│                                                                           │
│   INSTRUMENT STAGE (this module, owned by wt_dawinst): notes → dry track  │
│   buffer, float32 stereo (2, N) @ 48 kHz, ABSOLUTE-sample placement,      │
│   DECLARED tails — the P0 engine's conventions. A voice is EXACTLY zero   │
│   at and beyond dur + tail(patch); note_voice() returns shape             │
│   (2, dur + round(tail*sr)) and its last column is exactly 0.             │
│                                                                           │
│   CHAIN STAGE (wt_dawrack): inserts → sends → master. Nothing here        │
│   touches it. Until the chain stage goes stereo, engine.py's mono bus     │
│   consumes synth_note_mono() — (L+R)/2 of the same voice — and the rack   │
│   agent upgrades the call site to note_voice() when its stereo bus lands. │
│                                                                           │
│   RECORDING (wt_dawrec): capture is not this module's business.           │
└───────────────────────────────────────────────────────────────────────────┘

WHAT LIVES HERE
  - patches.json is the ONE table: registry rows (id, family, label, licence,
    attribution) AND engine facts (backend, file, tail, oneshot). store.js and
    routes.js read the same file; a patch added on one side only cannot exist.
  - Three real backends and one honest refusal:
      builtin   the P0 prototype synths (pluck/pad/drums) — zero-download
                first-run sound, delegated back to engine.SYNTHS unchanged.
      sf2       FluidSynth via ctypes against the official win-x64 build the
                downloader fetches (LGPL-2.1, dynamically loaded — clean).
                Backend decision 2026-08-26, by measurement not preference:
                liquidsfz (the report's SFZ pick) has NO python bindings, NO
                PyPI package, NO Windows binaries (0.4.1 ships a Linux LV2/
                JACK build + source), and this box has no C++ toolchain —
                a binding would need MSYS2 + a hand-written C shim over its
                C++-only API. FluidSynth renders real notes here TODAY.
      sfz       an in-house SFZ-subset voice for the CC0/CC-BY packs that have
                no SF2 edition (Karoryfer, VSCO2 CE, AVL). Opcode subset is
                documented at parse_sfz(); unknown opcodes are ignored.
                A `builtin` row whose name is a drums.py machine (tr808,
                tr909, tr808_bass, hybrid_kick) is the fourth real backend
                in all but name: zero-download circuits, but stereo and
                knob-driven, so they bypass engine.SYNTHS and go through the
                note cache like a sampled patch. See drums.py.
      generate  the four families no free sampleset does justice (sax, sitar,
                choir, solo cello) exist as rows that refuse to render with
                the report's honest message — generation is their answer.

DETERMINISM (pinned by instruments_test.py)
  Same project + same patch → byte-identical render. Three mechanisms:
  (1) every voice is computed in float64, cast to float32 and BACK — so a
      buffer that later replays from cache is bit-identical to first compute;
  (2) FluidSynth notes render on a FRESH synth each time (see
      _fluid_render_note for the measurement that forced this: a reused
      synth is history-dependent at ~-80 dB and no reset call cures it);
      with cpu-cores=1 and reverb/chorus off the fresh path measured
      byte-identical across runs, note orders and processes;
  (3) a per-note disk cache under <instruments>/_notecache keyed by
      (manifest rev, pack fingerprint, patch, midi, vel, dur, sr, params)
      -- and for the drum machines the "pack" fingerprint is drums.py's own
      source hash, because a synthesised patch has no bytes on disk to
      notice when its circuit is edited --
      amortises the fresh-synth cost to once per DISTINCT note and doubles
      as the containment if a backend ever drifts: the first bytes ARE the
      note. The sfz path is our own numpy and deterministic outright.

CLI (the test/bounce surface; engine.py serve stays the render path):
  python instruments.py probe                      what is installed
  python instruments.py note   <job.json>          one voice → raw .f32
  python instruments.py encode <job.json>          region wavs → one FLAC
"""
import ctypes
import ctypes.util
import hashlib
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# The drum machines are a sibling module. Same guard master.py uses: this
# directory must be importable by NAME whichever entry point got here first
# (engine.py as __main__, a test that reached in from outside, the CLI).
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import drums  # noqa: E402

MANIFEST_PATH = os.path.join(HERE, "patches.json")

_manifest = None


def manifest():
    global _manifest
    if _manifest is None:
        with open(MANIFEST_PATH, encoding="utf-8") as fh:
            _manifest = json.load(fh)
    return _manifest


def default_instruments_dir():
    env = os.environ.get("AIPLAY_DAW_INSTRUMENTS")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".aiplay-studio", "daw", "instruments")


def patch_row(pid):
    return manifest()["patches"].get(str(pid))


def effective_tails():
    """{patch id: tail seconds} for every patch that can render (the store's
    region hasher and this module must agree — probe_extra exposes this)."""
    return {pid: p["tail"] for pid, p in manifest()["patches"].items()
            if p["kind"] != "generate"}


class Refusal(Exception):
    """A patch that exists but honestly refuses to render locally."""


# ─────────────────────────────────────────────────────── the voice cache

def _f32_roundtrip(y):
    """float64 → float32 → float64, so cached replays are bit-identical."""
    return np.asarray(y, dtype=np.float32).astype(np.float64)


_fingerprints = {}


def _pack_fingerprint(row, instruments_dir):
    """The identity of the bytes behind a patch, so a re-installed or edited
    pack — or an edited CIRCUIT — can never replay stale note buffers: sfz
    mappings are small enough to hash outright; an SF2 is fingerprinted by its
    size (1.2 GB hashes are not worth a render's latency, and a soundfont swap
    that keeps the exact byte count is not a case worth paying for); a drum
    machine is fingerprinted by drums.py's own source."""
    f = row.get("file")
    if not f:
        # A drum machine's "pack" is drums.py itself: no file on disk means
        # nothing else would ever invalidate its cached notes when a circuit
        # is edited, so the module's own source hash stands in for the bytes.
        if row.get("kind") == "builtin" and drums.is_machine(row.get("builtin")):
            return drums.code_fingerprint()
        return "builtin"
    path = os.path.join(instruments_dir, *f.split("/"))
    try:
        st = os.stat(path)
    except OSError:
        return "missing"
    key = (path, st.st_mtime_ns, st.st_size)
    hit = _fingerprints.get(key)
    if hit is not None:
        return hit
    if row.get("kind") == "sfz":
        with open(path, "rb") as fh:
            fp = hashlib.sha1(fh.read()).hexdigest()[:16]
    else:
        fp = f"sz{st.st_size}"
    _fingerprints[key] = fp
    return fp


_rr_cache = {}


def _sfz_randomises(path):
    """True when a mapping picks between layers by ROUND ROBIN or random —
    that is, when the note seed changes the bytes. Derived from the mapping
    itself, never declared: a hand-set flag is a fact that can go stale, and
    parse_sfz is already memoised per (path, mtime) so this costs one parse."""
    try:
        key = (path, os.path.getmtime(path))
    except OSError:
        return False
    hit = _rr_cache.get(key)
    if hit is None:
        try:
            regions, _ = parse_sfz(path)
        except (OSError, ValueError):
            return False
        hit = any(int(r.get("seq_length", 1)) > 1 or "lorand" in r or "hirand" in r
                  for r in regions)
        _rr_cache[key] = hit
    return hit


def _seed_matters(row, instruments_dir):
    """Does the per-note seed change this patch's bytes?

    THE BUG THIS CLOSES (measured 2026-08-27, adding four round-robin packs):
    the note cache keyed on (patch, midi, vel, dur, params) and NOT the seed,
    so every hit of a drum at the same velocity and length replayed the FIRST
    round robin ever computed — the machine-gun artefact that round robins
    exist to prevent, and it was silently on for meatbass and the VSCO2
    section pizz too. The seed belongs in the key exactly when the mapping
    randomises: adding it unconditionally would give FluidSynth a cache miss
    per note, and an SF2 note costs a 0.9 s soundfont load."""
    if row.get("kind") != "sfz" or not row.get("file"):
        return False
    return _sfz_randomises(os.path.join(instruments_dir, *row["file"].split("/")))


def _cache_key(pid, midi, vel, dur, sr, seed, params, instruments_dir):
    row = patch_row(pid) or {}
    blob = json.dumps([manifest().get("rev", 0), row.get("rev", 0), pid,
                       _pack_fingerprint(row, instruments_dir),
                       int(midi), int(vel), int(dur), int(sr),
                       int(seed) & 0xFFFFFFFF if _seed_matters(row, instruments_dir) else 0,
                       sorted((params or {}).items())], separators=(",", ":"))
    return hashlib.sha1(blob.encode()).hexdigest()


def _cache_paths(instruments_dir, key):
    d = os.path.join(instruments_dir, "_notecache")
    return d, os.path.join(d, key + ".npy")


_CACHE_SWEEP_AT = 6000


def _cache_put(instruments_dir, key, y32):
    d, p = _cache_paths(instruments_dir, key)
    try:
        os.makedirs(d, exist_ok=True)
        tmp = p + f".tmp{os.getpid()}"
        with open(tmp, "wb") as fh:                    # a handle sidesteps
            np.save(fh, y32)                           # np.save's .npy-append
        os.replace(tmp, p)
        names = os.listdir(d)
        if len(names) > _CACHE_SWEEP_AT:
            full = [(os.path.getmtime(os.path.join(d, n)), n) for n in names]
            full.sort()
            for _, n in full[: len(full) - _CACHE_SWEEP_AT // 2]:
                try:
                    os.remove(os.path.join(d, n))
                except OSError:
                    pass
    except OSError:
        pass                      # a cache failure must never cost the render


def _cache_get(instruments_dir, key):
    _, p = _cache_paths(instruments_dir, key)
    try:
        y = np.load(p)
        return y if isinstance(y, np.ndarray) and y.ndim == 2 else None
    except (OSError, ValueError):
        return None


# ───────────────────────────────────────────────── backend: FluidSynth/SF2

class _FluidLib:
    """The dozen fluidsynth entry points this module needs, via ctypes."""

    def __init__(self, dll_path):
        if os.name == "nt":
            os.add_dll_directory(os.path.dirname(dll_path))
            self.lib = ctypes.CDLL(dll_path)
        else:
            self.lib = ctypes.CDLL(dll_path)
        L = self.lib
        L.new_fluid_settings.restype = ctypes.c_void_p
        L.new_fluid_synth.restype = ctypes.c_void_p
        L.new_fluid_synth.argtypes = [ctypes.c_void_p]
        L.fluid_settings_setnum.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_double]
        L.fluid_settings_setint.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        L.fluid_synth_sfload.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        L.fluid_synth_program_select.argtypes = [ctypes.c_void_p] + [ctypes.c_int] * 4
        L.fluid_synth_noteon.argtypes = [ctypes.c_void_p] + [ctypes.c_int] * 3
        L.fluid_synth_noteoff.argtypes = [ctypes.c_void_p] + [ctypes.c_int] * 2
        L.fluid_synth_system_reset.argtypes = [ctypes.c_void_p]
        L.fluid_synth_all_sounds_off.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.delete_fluid_synth.argtypes = [ctypes.c_void_p]
        L.delete_fluid_settings.argtypes = [ctypes.c_void_p]
        L.fluid_synth_write_float.argtypes = [
            ctypes.c_void_p, ctypes.c_int,
            ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
            ctypes.c_void_p, ctypes.c_int, ctypes.c_int]

    @staticmethod
    def find_dll(instruments_dir):
        root = os.path.join(instruments_dir, "runtime", "fluidsynth")
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.lower().startswith("libfluidsynth") and f.lower().endswith((".dll", ".so", ".dylib")):
                    return os.path.join(dirpath, f)
        # a system fluidsynth is an acceptable stand-in (Linux/macOS dev)
        found = ctypes.util.find_library("fluidsynth")
        return found


_flib_cache = {}


def _fluid_lib(instruments_dir):
    dll = _FluidLib.find_dll(instruments_dir)
    if not dll:
        raise Refusal(
            "The FluidSynth runtime is not installed — install the "
            "'fluidsynth' runtime from the patch browser (daw_patches) first.")
    lib = _flib_cache.get(dll)
    if lib is None:
        lib = _FluidLib(dll)
        _flib_cache[dll] = lib
    return lib


def _fluid_render_note(instruments_dir, sf2_path, sr, bank, prog, chan,
                       midi, vel, dur, tail_samples):
    """One note on a FRESH synth, torn down afterwards.

    WHY FRESH, measured 2026-08-26 on this box: a reused synth is history-
    dependent at about -80 dB — the first voice that touches a cold sample
    renders microscopically differently from every later one (all_sounds_off
    + system_reset + a warmup note + dynamic-sample-loading off were each
    tried; the A-B-A byte diff survived them all). A fresh synth replays the
    exact same call sequence every time and came back byte-identical across
    runs, orders AND processes. The cost is the sfload per note (~0.9 s for
    the 1.2 GB Salamander, milliseconds for small banks) — paid once per
    DISTINCT note ever, because the note cache replays it from then on."""
    flib = _fluid_lib(instruments_dir)
    L = flib.lib
    settings = L.new_fluid_settings()
    synth = None
    try:
        L.fluid_settings_setnum(settings, b"synth.sample-rate", float(sr))
        L.fluid_settings_setnum(settings, b"synth.gain", 0.7)
        L.fluid_settings_setint(settings, b"synth.reverb.active", 0)
        L.fluid_settings_setint(settings, b"synth.chorus.active", 0)
        # ONE core: multithreaded voice mixing reorders float sums.
        L.fluid_settings_setint(settings, b"synth.cpu-cores", 1)
        # Lazy sample data: only the touched samples are read from disk.
        L.fluid_settings_setint(settings, b"synth.dynamic-sample-loading", 1)
        synth = L.new_fluid_synth(settings)
        if not synth:
            raise RuntimeError("fluidsynth: new_fluid_synth failed")
        sfid = L.fluid_synth_sfload(synth, sf2_path.encode("utf-8"), 1)
        if sfid < 0:
            raise RuntimeError(f"fluidsynth could not load {sf2_path}")
        L.fluid_synth_program_select(synth, chan, sfid, bank, prog)
        n = int(dur + tail_samples)
        left = np.zeros(n, dtype=np.float32)
        right = np.zeros(n, dtype=np.float32)
        lp = left.ctypes.data_as(ctypes.c_void_p)
        rp = right.ctypes.data_as(ctypes.c_void_p)
        L.fluid_synth_noteon(synth, chan, int(midi), int(vel))
        L.fluid_synth_write_float(synth, int(dur), lp, 0, 1, rp, 0, 1)
        L.fluid_synth_noteoff(synth, chan, int(midi))
        lp2 = ctypes.c_void_p(left.ctypes.data + 4 * int(dur))
        rp2 = ctypes.c_void_p(right.ctypes.data + 4 * int(dur))
        L.fluid_synth_write_float(synth, int(tail_samples), lp2, 0, 1, rp2, 0, 1)
        return np.stack([left, right]).astype(np.float64)
    finally:
        if synth:
            L.delete_fluid_synth(synth)
        L.delete_fluid_settings(settings)


def _sf2_voice(row, midi, vel, dur, sr, params, instruments_dir):
    sf2 = os.path.join(instruments_dir, *row["file"].split("/"))
    if not os.path.isfile(sf2):
        raise Refusal(f"Patch '{row['id']}' is not installed — its soundfont is "
                      f"missing. Install it from the patch browser (daw_patches).")
    bank = int(row.get("bank", 0))
    prog = int(row.get("program", 0))
    chan = 0
    if row.get("gm_programs"):                       # GeneralUser: params pick
        prog = int((params or {}).get("program", prog)) % 128
        if (params or {}).get("drum_kit"):
            bank, chan = 128, 9
    tail_samples = int(round(row["tail"] * sr))
    return _fluid_render_note(instruments_dir, sf2, sr, bank, prog, chan,
                              midi, vel, dur, tail_samples)


# ─────────────────────────────────────────────── backend: SFZ subset voice
#
# Opcode subset, chosen against the four packs this manifest actually ships
# (AVL Black Pearl / Red Zeppelin, Karoryfer Meatbass, the generated VSCO2
# mappings): sample, key/lokey/hikey, lovel/hivel, pitch_keycenter, tune,
# transpose, volume, pan, amp_veltrack, amp_velcurve_N, ampeg_attack/hold/
# decay/sustain/release, loop_mode/loop_start/loop_end, offset, seq_length/
# seq_position, lorand/hirand, trigger, loccN/hiccN against <control> set_ccN
# defaults, #include, #define, <control> default_path. Everything else is
# read and IGNORED (CC modulation, LFOs, EGs, legato scripting) — stated
# rather than half-implemented.
#
# ONE opcode is OURS and not the format's: `key_map` on the PATCH ROW (not in
# the .sfz) translates the played MIDI note before region matching, so a pack
# laid out on its own keys is playable on GM ones. MuldjordKit needs it — its
# kick is on key 48 and its snare on 50, so a GM beat would otherwise render
# silence. It lives in patches.json because the pack's own file is downloaded
# and must stay byte-for-byte what its author published.

_sfz_cache = {}
_sample_cache = {}
_SAMPLE_CACHE_MAX = 96


def _sfz_tokenize(text):
    out = []
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].strip()
        if line:
            out.append(line)
    return "\n".join(out)


def parse_sfz(path, _depth=0):
    """→ (regions, control) with inheritance resolved. Cached by (path, mtime)."""
    key = (path, os.path.getmtime(path))
    hit = _sfz_cache.get(key)
    if hit is not None:
        return hit
    if _depth > 8:
        raise ValueError("sfz #include nesting too deep")
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    defines = {}
    control = {}
    regions = []
    scopes = {"global": {}, "master": {}, "group": {}}
    cur = None                     # (kind, dict)
    header = None

    def close_region():
        nonlocal cur
        if cur and cur[0] == "region":
            merged = {}
            for k in ("global", "master", "group"):
                merged.update(scopes[k])
            merged.update(cur[1])
            if "sample" in merged:
                regions.append(merged)
        cur = None

    tokens = _sfz_tokenize(text).replace("\n", " ").split(" ")
    i = 0
    pending_key = None
    pending_val = []

    def flush_pair(target):
        nonlocal pending_key, pending_val
        if pending_key is not None:
            target[pending_key] = " ".join(pending_val).strip()
        pending_key, pending_val = None, []

    def target_dict():
        if header == "control":
            return control
        if header in ("global", "master", "group"):
            return scopes[header]
        if cur and cur[0] == "region":
            return cur[1]
        return {}

    while i < len(tokens):
        tok = tokens[i]
        if not tok:
            i += 1
            continue
        if tok.startswith("#define"):
            flush_pair(target_dict())
            name, val = tokens[i + 1], tokens[i + 2]
            defines[name] = val
            i += 3
            continue
        if tok.startswith("#include"):
            flush_pair(target_dict())
            # the path is quoted and may contain spaces — reassemble
            frag = tokens[i + 1]
            i += 2
            while not frag.rstrip().endswith('"') and i < len(tokens):
                frag += " " + tokens[i]
                i += 1
            inc = frag.strip().strip('"')
            inc_path = os.path.normpath(os.path.join(os.path.dirname(path), inc.replace("\\", os.sep)))
            sub_regions, sub_control = parse_sfz(inc_path, _depth + 1)
            regions.extend(sub_regions)
            for k, v in sub_control.items():
                control.setdefault(k, v)
            continue
        if tok.startswith("<") and tok.endswith(">"):
            flush_pair(target_dict())
            close_region()
            header = tok[1:-1]
            if header == "region":
                cur = ("region", {})
            elif header == "group":
                scopes["group"] = {}
            elif header == "master":
                scopes["master"] = {}
                scopes["group"] = {}
            elif header == "global":
                scopes["global"] = {}
                scopes["master"] = {}
                scopes["group"] = {}
            i += 1
            continue
        for name, val in defines.items():
            if name in tok:
                tok = tok.replace(name, val)
        if "=" in tok:
            flush_pair(target_dict())
            k, v = tok.split("=", 1)
            pending_key, pending_val = k.lower(), [v]
        elif pending_key is not None:
            pending_val.append(tok)
        i += 1
    flush_pair(target_dict())
    close_region()
    _sfz_cache[key] = (regions, control)
    return regions, control


_NOTE_RE = None


def _sfz_key(v):
    """An sfz key value: a MIDI number or a note name like c#4 / db3."""
    s = str(v).strip().lower()
    try:
        return int(s)
    except ValueError:
        pass
    names = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
    if not s or s[0] not in names:
        raise ValueError(f"bad sfz key: {v}")
    semitone = names[s[0]]
    rest = s[1:]
    while rest and rest[0] in "#b":
        semitone += 1 if rest[0] == "#" else -1
        rest = rest[1:]
    return (int(rest) + 1) * 12 + semitone           # c4 = 60 (sfz convention)


def _load_sample(path, sr):
    """→ float64 (2, n) at engine rate. Decoded via soundfile, LRU-cached."""
    key = (path, sr)
    hit = _sample_cache.get(key)
    if hit is not None:
        return hit
    import soundfile as sf
    data, s_sr = sf.read(path, dtype="float64", always_2d=True)
    y = data.T                                       # (ch, n)
    if y.shape[0] == 1:
        y = np.vstack([y, y])
    elif y.shape[0] > 2:
        y = y[:2]
    if s_sr != sr:
        n_out = int(round(y.shape[1] * sr / s_sr))
        x_old = np.arange(y.shape[1]) * (sr / s_sr)
        x_new = np.arange(n_out)
        y = np.vstack([np.interp(x_new, x_old, y[0]), np.interp(x_new, x_old, y[1])])
    if len(_sample_cache) >= _SAMPLE_CACHE_MAX:
        _sample_cache.pop(next(iter(_sample_cache)))
    _sample_cache[key] = y
    return y


def _resample_ratio(y, ratio, n_out):
    """Read y (2, n) at fractional step `ratio`, linear interp, n_out frames."""
    pos = np.arange(n_out) * ratio
    idx = np.minimum(pos.astype(np.int64), y.shape[1] - 1)
    nxt = np.minimum(idx + 1, y.shape[1] - 1)
    frac = pos - idx
    return y[:, idx] * (1 - frac) + y[:, nxt] * frac


def _loop_extend(y, loop_start, loop_end, need):
    """Repeat [loop_start, loop_end) until at least `need` frames exist."""
    if loop_end <= loop_start or loop_end > y.shape[1]:
        return y
    if y.shape[1] >= need:
        return y
    body = y[:, loop_start:loop_end]
    reps = int(math.ceil((need - loop_start) / body.shape[1])) + 1
    return np.concatenate([y[:, :loop_start]] + [body] * reps, axis=1)[:, :need]


def _vel_amp(region, vel):
    """amp_velcurve_N points (piecewise linear) or the sfz default square."""
    points = sorted(
        (int(k.rsplit("_", 1)[1]), float(v))
        for k, v in region.items() if k.startswith("amp_velcurve_"))
    if points:
        xs = [0] + [p[0] for p in points] + ([127] if points[-1][0] != 127 else [])
        ys = [0.0] + [p[1] for p in points] + ([points[-1][1]] if points[-1][0] != 127 else [])
        return float(np.interp(vel, xs, ys))
    track = float(region.get("amp_veltrack", 100)) / 100.0
    base = (vel / 127.0) ** 2
    return (1.0 - track) + track * base


def _cc_pass(region, control):
    for k, v in region.items():
        if k.startswith("locc") or k.startswith("hicc"):
            try:
                cc = int(k[4:])
                cur = float(control.get(f"set_cc{cc}", 0))
                bound = float(v)
            except ValueError:
                continue
            if k.startswith("locc") and cur < bound:
                return False
            if k.startswith("hicc") and cur > bound:
                return False
    return True


def _sfz_voice(row, midi, vel, dur, sr, params, instruments_dir, rng):
    """One sfz voice. `key_map` in the manifest row translates the incoming
    MIDI note BEFORE region matching, which is how a pack laid out on its own
    keys becomes playable on GM ones — the MuldjordKit puts its kick on 48 and
    its snare on 50, so without this a GM beat written on 36/38 renders
    SILENCE. A key the map does not name passes through untouched, so the
    pack's native layout still reaches anything the map leaves alone."""
    km = row.get("key_map")
    if km:
        midi = int(km.get(str(int(midi)), midi))
    sfz_path = os.path.join(instruments_dir, *row["file"].split("/"))
    if not os.path.isfile(sfz_path):
        raise Refusal(f"Patch '{row['id']}' is not installed — its mapping is "
                      f"missing. Install it from the patch browser (daw_patches).")
    regions, control = parse_sfz(sfz_path)
    oneshot = bool(row.get("oneshot"))
    tail_samples = int(round(row["tail"] * sr))
    total = dur + tail_samples

    cands = []
    for r in regions:
        trig = r.get("trigger", "attack")
        if trig not in ("attack", "first"):
            continue
        key = r.get("key")
        lo = _sfz_key(r.get("lokey", key if key is not None else 0))
        hi = _sfz_key(r.get("hikey", key if key is not None else 127))
        if not (lo <= midi <= hi):
            continue
        if not (int(r.get("lovel", 1)) <= vel <= int(r.get("hivel", 127))):
            continue
        if not _cc_pass(r, control):
            continue
        cands.append(r)
    if not cands:
        return np.zeros((2, total))

    # round-robin and random layers, seeded per note → deterministic
    rr_len = max([int(c.get("seq_length", 1)) for c in cands], default=1)
    rr_pick = 1 + int(rng.integers(rr_len)) if rr_len > 1 else 1
    rand = float(rng.random())
    chosen = []
    for r in cands:
        if int(r.get("seq_length", 1)) > 1 and int(r.get("seq_position", 1)) != min(rr_pick, int(r.get("seq_length", 1))):
            continue
        lorand = float(r.get("lorand", 0.0))
        hirand = float(r.get("hirand", 1.0))
        if not (lorand <= rand < hirand or (hirand >= 1.0 and rand >= 1.0)):
            continue
        chosen.append(r)
    if not chosen:
        chosen = cands[:1]

    default_path = control.get("default_path", "")
    out = np.zeros((2, total))
    for r in chosen:
        rel = (default_path + r["sample"]).replace("\\", os.sep)
        spath = os.path.normpath(os.path.join(os.path.dirname(sfz_path), rel))
        try:
            y = _load_sample(spath, sr)
        except Exception as exc:
            # LOUD, not mute: a region that cannot load is a broken install,
            # and a silently-thinner mix is the worst way to learn that.
            raise RuntimeError(f"{row['id']}: sample failed to load: {spath} ({exc})") from exc
        keycenter = _sfz_key(r.get("pitch_keycenter", r.get("key", midi)))
        semis = (midi - keycenter) + float(r.get("transpose", 0)) + float(r.get("tune", 0)) / 100.0
        ratio = 2.0 ** (semis / 12.0)
        offset = int(float(r.get("offset", 0)))
        if offset:
            y = y[:, offset:]
        loop_mode = r.get("loop_mode", "no_loop")
        release_s = float(r.get("ampeg_release", 0.35))
        if oneshot or loop_mode == "one_shot":
            n_need = min(total, int(y.shape[1] / ratio))
        else:
            n_need = min(total, int(y.shape[1] / ratio))
            want = dur + int(release_s * sr)
            if loop_mode in ("loop_continuous", "loop_sustain"):
                ls = int(float(r.get("loop_start", 0)))
                le = int(float(r.get("loop_end", y.shape[1] - 1))) + 1
                y = _loop_extend(y, ls, le, int(want * ratio) + 2)
                n_need = min(total, want)
        v = _resample_ratio(y, ratio, n_need)

        env = np.ones(n_need)
        atk = int(float(r.get("ampeg_attack", 0.0)) * sr)
        if atk > 1:
            env[:min(atk, n_need)] *= np.linspace(0, 1, min(atk, n_need))
        sus = float(r.get("ampeg_sustain", 100.0)) / 100.0
        dec = int(float(r.get("ampeg_decay", 0.0)) * sr)
        hold = int(float(r.get("ampeg_hold", 0.0)) * sr)
        if dec > 1 and sus < 1.0:
            d0 = min(atk + hold, n_need)
            d1 = min(d0 + dec, n_need)
            if d1 > d0:
                env[d0:d1] *= np.linspace(1, sus, d1 - d0)
            env[d1:] *= sus
        if not (oneshot or loop_mode == "one_shot") and n_need > dur:
            rel_n = n_need - dur
            env[dur:] *= np.linspace(1, 0, rel_n)     # release: linear to zero
        amp = _vel_amp(r, vel) * (10.0 ** (float(r.get("volume", 0.0)) / 20.0))
        pan = float(r.get("pan", 0.0)) / 100.0        # -1..1
        gl = math.sqrt(0.5 * (1 - pan))
        gr = math.sqrt(0.5 * (1 + pan))
        out[0, :n_need] += v[0] * env * amp * gl * math.sqrt(2)
        out[1, :n_need] += v[1] * env * amp * gr * math.sqrt(2)
    return out


# ──────────────────────────────────────────────────────── the public stage

def _gate2(y, total, sr):
    """The P0 gate, stereo: pin to declared length, fade the last 10 ms,
    end EXACTLY at zero — the region-seam proof's invariant."""
    out = np.zeros((2, total))
    n = min(y.shape[1], total)
    out[:, :n] = y[:, :n]
    fade = min(int(0.010 * sr), total)
    if fade > 1:
        out[:, total - fade:] *= np.linspace(1.0, 0.0, fade)[None, :]
    out[:, -1] = 0.0
    return out



def _daw_engine():
    """This directory's engine.py — never the compositor's.

    Two things make a bare `import engine` the wrong tool here. It is
    AMBIGUOUS: server/vfx has an engine.py too, and anything that puts that
    directory on sys.path (rack.py imports the shared keyframe evaluator from
    it) can win the name. And it is WASTEFUL: when engine.py is the entry
    point it runs as `__main__`, so importing "engine" executes a second copy
    of it rather than handing back the one already rendering.

    So resolve by FILE. The module already loaded from this directory is the
    answer whenever there is one, which is every path that reaches here from a
    render; the path-based import is the fallback for a test that reaches in
    from outside.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    want = os.path.join(here, "engine.py")
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", None)
        if f and os.path.abspath(f) == want and hasattr(mod, "SYNTHS"):
            return mod
    import importlib.util as _iu
    spec = _iu.spec_from_file_location("daw_engine", want)
    mod = _iu.module_from_spec(spec)
    sys.modules.setdefault("daw_engine", mod)
    spec.loader.exec_module(mod)
    return mod


def note_voice(pid, midi, dur_samples, vel127, sr, seed, params=None, instruments_dir=None):
    """One note → float32-exact float64 stereo (2, dur + tail*sr). THE seam."""
    row = patch_row(pid)
    if row is None:
        raise ValueError(f"unknown patch {pid!r} — daw_patches lists what exists")
    if row["kind"] == "generate":
        raise Refusal(row.get("refusal") or (
            f"'{row.get('label', pid)}' is a generate-this-part placeholder — no "
            f"free sampleset does it justice; generate the part with Music 3.0 instead."))
    instruments_dir = instruments_dir or default_instruments_dir()
    params = dict(params or {})
    midi = int(midi) + int(params.get("transpose", 0) or 0)
    midi = min(max(midi, 0), 127)
    vel127 = min(max(int(vel127), 1), 127)
    dur = max(1, int(dur_samples))
    gain = 10.0 ** (float(params.get("gain_db", 0) or 0) / 20.0)
    tail = int(round(row["tail"] * sr))
    total = dur + tail

    if row["kind"] == "builtin":
        # ── THE DRUM MACHINES: builtin, but stereo and knob-driven ───────
        # drums.py voices are the only builtins that read the patch's
        # declared params, so they cannot go through engine.SYNTHS (whose
        # signature has no params slot). They DO go through the note cache:
        # a hi-hat on every 16th is one distinct (midi, vel, dur, params)
        # tuple played four hundred times, and a machine repeats exactly.
        if drums.is_machine(row["builtin"]):
            key = _cache_key(pid, midi, vel127, dur, sr, 0, params, instruments_dir)
            cached = _cache_get(instruments_dir, key)
            if cached is not None and cached.shape == (2, total):
                return cached.astype(np.float64)
            y = drums.voice(row["builtin"], midi, dur, vel127, sr, params) * gain
            y32 = np.asarray(_gate2(y, total, sr), dtype=np.float32)
            _cache_put(instruments_dir, key, y32)
            return y32.astype(np.float64)
        engine = _daw_engine()
        rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
        mono = engine.SYNTHS[row["builtin"]](midi, dur, vel127 / 127.0, sr, rng)
        y = np.vstack([mono, mono]) * gain
        # The roundtrip comes AFTER the gate, not before: the gate's fade
        # ramp is float64 arithmetic and would put values back off the
        # float32 grid. Every backend leaves this function float32-exact.
        return _f32_roundtrip(_gate2(y, total, sr))

    key = _cache_key(pid, midi, vel127, dur, sr, seed, params, instruments_dir)
    cached = _cache_get(instruments_dir, key)
    if cached is not None and cached.shape == (2, total):
        return cached.astype(np.float64)

    if row["kind"] == "sf2":
        y = _sf2_voice(dict(row, id=pid), midi, vel127, dur, sr, params, instruments_dir)
    elif row["kind"] == "sfz":
        rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
        y = _sfz_voice(dict(row, id=pid), midi, vel127, dur, sr, params, instruments_dir, rng)
    else:
        raise ValueError(f"patch {pid!r} has unknown kind {row['kind']!r}")
    y = _gate2(y * gain * float(row.get("gain", 1.0)), total, sr)
    y32 = np.asarray(y, dtype=np.float32)
    _cache_put(instruments_dir, key, y32)
    return y32.astype(np.float64)


def synth_note_mono(pid, midi, dur_samples, vel127, sr, seed, params=None, instruments_dir=None):
    """The mono consumption of the stereo contract — engine.py's current bus.
    (L+R)/2 in float64 of float32-exact channels stays deterministic."""
    y = note_voice(pid, midi, dur_samples, vel127, sr, seed, params, instruments_dir)
    return (y[0] + y[1]) * 0.5


def installed_state(instruments_dir=None):
    """{patch id: bool} — a patch is installed when its engine file exists.
    Builtins are always installed; generate rows are never 'installed'."""
    instruments_dir = instruments_dir or default_instruments_dir()
    out = {}
    for pid, row in manifest()["patches"].items():
        if row["kind"] == "builtin":
            out[pid] = True
        elif row["kind"] == "generate":
            out[pid] = False
        else:
            f = os.path.join(instruments_dir, *row["file"].split("/"))
            ok = os.path.isfile(f)
            if ok and row["kind"] == "sf2":
                ok = _FluidLib.find_dll(instruments_dir) is not None
            out[pid] = ok
    return out


def probe_extra(job=None):
    """Merged into engine.probe() by the DAWINST SEAM block: what the
    instrument stage speaks, so the e2e can hold store and engine to ONE table."""
    instruments_dir = (job or {}).get("instruments_dir") or default_instruments_dir()
    return {
        "patch_tails": effective_tails(),
        "patches_installed": installed_state(instruments_dir),
        "instruments_dir": instruments_dir,
        "sampler_backend": "fluidsynth+sfz-subset",
    }


# ─────────────────────────────────────────────────────────────── CLI modes

def _cli_note(job):
    y = note_voice(job["patch"], int(job["midi"]), int(job["dur_samples"]),
                   int(job.get("vel", 100)), int(job.get("sr", 48000)),
                   int(job.get("seed", 0)), job.get("params"),
                   job.get("instruments_dir"))
    out = job.get("out")
    if out:
        np.asarray(y, dtype="<f4").tofile(out)
    peak = float(np.max(np.abs(y)))
    return {"ok": True, "shape": list(y.shape), "peak": round(peak, 6),
            "sha1": hashlib.sha1(np.asarray(y, dtype="<f4").tobytes()).hexdigest()}


def _cli_encode(job):
    """Concatenate engine region wavs (float32 mono) → one FLAC for the bounce.
    soundfile carries the whole container job; 24-bit keeps the master honest.

    ── BIT-DEPTH REDUCTION IS THE ONLY PLACE DITHER BELONGS (agent/master) ──
    `bit_depth` (16 or 24, default 24 — the unchanged behaviour) and `dither`
    (default: on whenever the depth is under 24) are additive. Writing 16-bit
    by plain truncation turns a fade into quantisation distortion that
    correlates with the music; server/daw/master.py::apply_dither converts it
    into a steady, noise-shaped floor and keeps sub-LSB information audible.
    24-bit needs no dither (its floor is already 45 dB under the room), so
    the default path below is byte-for-byte what it was.

    The ROUTE that builds this job is server/daw/routes.js's `bounce` case;
    it does not pass bit_depth yet, so exposing the option to a caller is
    one line there — see the BOUNCE WIRING note at the bottom of master.py.
    """
    import soundfile as sf
    sr = int(job.get("sr", 48000))
    parts = []
    for p in job["wav_parts"]:
        data, w_sr = sf.read(p, dtype="float32", always_2d=True)
        if w_sr != sr:
            raise ValueError(f"{p}: {w_sr} Hz region in a {sr} Hz bounce")
        parts.append(data)
    y = np.concatenate(parts, axis=0) if parts else np.zeros((0, 1), dtype="float32")
    bits = int(job.get("bit_depth") or 24)
    if bits not in (16, 24):
        raise ValueError(f"bit_depth must be 16 or 24, got {bits}")
    dithered = False
    if bits < 24 and job.get("dither") is not False and y.size:
        import master  # noqa: PLC0415 -- only the reduced-depth path needs it
        y = master.apply_dither(np.asarray(y, dtype=np.float64).T,
                                bits=bits,
                                noise_shape=str(job.get("noise_shape") or "shaped"),
                                seed=int(job.get("dither_seed") or 1)).T
        dithered = True
    sf.write(job["out"], y, sr, subtype=f"PCM_{bits}")
    return {"ok": True, "out": job["out"], "seconds": round(y.shape[0] / sr, 3),
            "channels": int(y.shape[1]), "bit_depth": bits, "dithered": dithered}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if not argv:
            raise ValueError("usage: instruments.py <probe|note|encode> [job.json]")
        mode = argv[0]
        if mode == "probe":
            print(json.dumps({"ok": True, **probe_extra()}))
            return 0
        with open(argv[1], encoding="utf-8") as fh:
            job = json.load(fh)
        if mode == "note":
            print(json.dumps(_cli_note(job)))
        elif mode == "encode":
            print(json.dumps(_cli_encode(job)))
        else:
            raise ValueError(f"unknown mode {mode}")
        return 0
    except Refusal as exc:
        print(json.dumps({"ok": False, "refusal": True, "error": str(exc)}))
        return 1
    except Exception as exc:                           # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
