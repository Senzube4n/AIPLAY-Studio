"""Isolated, effects-only VST3 host. Each request starts a fresh process.

No plugin is imported by folder discovery. Before loading a binary this worker
checks its registered content hash; a project never supplies an executable path.
"""
import argparse
import base64
import hashlib
import json
import math
import os
import platform
from pathlib import Path
import re
import stat
import sys
import zipfile

MAX_STATE = 4 * 1024 * 1024
MAX_BUNDLE_BYTES = 1024 * 1024 * 1024
MAX_FILES = 10000


def bundle_fingerprint(root):
    root = Path(root)
    if root.is_symlink() or not root.exists():
        raise ValueError("Plugin is missing or is a symbolic link. Scan and inspect it again.")
    files = []
    if root.is_file():
        files.append(("", root))
    elif root.is_dir():
        for parent, dirs, names in os.walk(root, followlinks=False):
            for name in dirs + names:
                if (Path(parent) / name).is_symlink():
                    raise ValueError("Plugin bundles cannot contain symbolic links.")
            for name in names:
                file = Path(parent) / name
                if not file.is_file():
                    raise ValueError("Plugin bundle contains a non-regular file.")
                files.append((file.relative_to(root).as_posix(), file))
                if len(files) > MAX_FILES:
                    raise ValueError("Plugin bundle contains too many files.")
    else:
        raise ValueError("Choose a VST3 file or bundle.")
    result, total = hashlib.sha256(), 0
    for relative, file in sorted(files):
        before = file.stat()
        total += before.st_size
        if total > MAX_BUNDLE_BYTES:
            raise ValueError("Plugin bundle exceeds the 1 GiB limit.")
        digest = hashlib.sha256()
        with file.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        after = file.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("Plugin changed while its contents were checked.")
        result.update((relative + "\0" + str(before.st_size) + ":" + digest.hexdigest() + "\0").encode("utf-8"))
    if not files:
        raise ValueError("Plugin bundle is empty.")
    return result.hexdigest()


def registered(job):
    registry = Path(job["registry"])
    if registry.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Plugin registry exceeds its size limit.")
    data = json.loads(registry.read_text(encoding="utf-8"))
    entry = data.get("plugins", {}).get(job.get("id"))
    if not entry or not entry.get("path") or not Path(entry["path"]).is_absolute():
        raise ValueError("Plugin is not registered on this machine. Scan and inspect it first.")
    if not str(entry["path"]).lower().endswith(".vst3"):
        raise ValueError("Only registered VST3 effects can run here.")
    if os.path.normcase(str(Path(entry["path"]).resolve())) != os.path.normcase(entry["path"]):
        raise ValueError("Plugin location changed. Scan and inspect it again.")
    expected = job.get("fingerprint")
    if not re.fullmatch(r"[a-f0-9]{64}", str(expected or "")) or entry.get("fingerprint") != expected:
        raise ValueError("Saved plugin identity does not match this machine. Inspect and add it again.")
    if bundle_fingerprint(entry["path"]) != expected:
        raise ValueError("Plugin files changed. Inspect and add the updated plugin again.")
    return entry


def plugin_load_path(entry):
    """Pedalboard on Windows loads the architecture binary, not its bundle."""
    root = Path(entry["path"])
    if os.name != "nt" or not root.is_dir():
        return str(root)
    architecture = "arm64-win" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64-win"
    directory = root / "Contents" / architecture
    candidates = sorted(directory.glob("*.vst3")) if directory.is_dir() else []
    if len(candidates) != 1 or not candidates[0].is_file() or candidates[0].is_symlink():
        raise ValueError("This bundle has no single VST3 binary for this computer's architecture.")
    return str(candidates[0])


def load_effect(entry):
    from pedalboard import load_plugin
    file = plugin_load_path(entry)
    try:
        return load_plugin(file)
    except Exception as error:
        if os.name == "nt" and len(file) > 240:
            raise ValueError("The native plugin could not load from this long Windows path. Move the plugin to a shorter folder and inspect it again.") from error
        raise


def checked_state(value):
    if not isinstance(value, str) or len(value) > (MAX_STATE * 4 // 3 + 8):
        raise ValueError("Plugin preset state exceeds 4 MiB.")
    try:
        raw = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ValueError("Plugin preset state is not valid base64.") from exc
    if len(raw) > MAX_STATE:
        raise ValueError("Plugin preset state exceeds 4 MiB.")
    return raw


def checked_params(schema, values):
    if not isinstance(values, dict) or len(values) > 256:
        raise ValueError("Use a parameter object with at most 256 entries.")
    output = {}
    for key, value in values.items():
        spec = schema.get(key)
        if spec is None:
            raise ValueError("Unknown plugin parameter: " + str(key))
        kind = spec["type"]
        if kind == "bool":
            if type(value) is not bool:
                raise ValueError(key + " requires true or false.")
        elif kind == "number":
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError(key + " requires a finite number.")
            if value < spec["min"] or value > spec["max"]:
                raise ValueError(key + " is outside its supported range.")
            step = spec.get("step")
            if step and abs((value - spec["min"]) / step - round((value - spec["min"]) / step)) > 1e-6:
                raise ValueError(key + " requires one of its supported numeric steps.")
        elif kind == "enum":
            if value not in spec["values"]:
                raise ValueError(key + " requires one of its listed values.")
        else:
            raise ValueError("Unsupported plugin parameter: " + key)
        output[key] = value
    return output


def inspect_plugin(job):
    import importlib.metadata
    entry = registered(job)
    plugin = load_effect(entry)
    if plugin.is_instrument:
        raise ValueError("This is an instrument. The DAW plugin rack currently accepts audio effects.")
    specs, warnings = {}, []
    for key, parameter in plugin.parameters.items():
        if len(specs) >= 256 or len(key) > 120 or not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", key) or key in ("__proto__", "prototype", "constructor"):
            warnings.append("Some parameters were omitted from the 256-control rack.")
            continue
        value = getattr(plugin, key)
        label = str(getattr(parameter, "name", None) or key.replace("_", " ").title())[:160]
        spec = {"label": label}
        if parameter.type is bool:
            spec.update(type="bool", default=bool(value))
        elif parameter.type in (float, int):
            lo, hi = parameter.min_value, parameter.max_value
            if lo is not None and float(lo) == -math.inf and hi is not None and math.isfinite(float(hi)):
                lo = -120.0
                warnings.append("Negative-infinity ranges use a -120 floor: " + key)
            if lo is None or hi is None or not all(math.isfinite(float(x)) for x in (lo, hi, value)):
                warnings.append("An unbounded numeric parameter was omitted: " + key)
                continue
            spec.update(type="number", default=float(value), min=float(lo), max=float(hi))
            step = getattr(parameter, "step_size", None)
            if step and math.isfinite(float(step)) and step > 0:
                spec["step"] = float(step)
        else:
            values = list(dict.fromkeys(str(x) for x in parameter.valid_values))
            if not values or len(values) > 256 or any(len(x) > 256 or any(ord(c) < 32 for c in x) for x in values) or str(value) not in values:
                warnings.append("An unsupported text parameter was omitted: " + key)
                continue
            spec.update(type="enum", default=str(value), values=values)
        specs[key] = spec
    state = bytes(plugin.raw_state)
    if len(state) > MAX_STATE:
        raise ValueError("This plugin's preset state exceeds the 4 MiB rack limit.")
    return {"ok": True, "label": str(getattr(plugin, "name", None) or Path(entry["path"]).stem)[:160],
            "hostVersion": importlib.metadata.version("pedalboard"), "parameters": specs,
            "state": base64.b64encode(state).decode("ascii"),
            "latencySamples": int(getattr(plugin, "reported_latency_samples", 0)), "warnings": sorted(set(warnings))}


def process_plugin(job):
    import importlib.metadata
    import numpy as np
    entry = registered(job)
    descriptor = entry.get("descriptor")
    version = importlib.metadata.version("pedalboard")
    if not descriptor or entry.get("status") != "ready":
        raise ValueError("Inspect this plugin before using it in a project.")
    if descriptor.get("hostVersion") != version or (job.get("hostVersion") and job["hostVersion"] != version):
        raise ValueError("The VST host changed. Inspect and add this plugin again.")
    values = checked_params(descriptor["parameters"], job.get("params", {}))
    state = checked_state(job.get("state", descriptor["state"]))
    source = Path(job["input"])
    if source.stat().st_size > 512 * 1024 * 1024:
        raise ValueError("Plugin audio exceeds the 512 MiB processing limit.")
    audio = np.load(source, allow_pickle=False)
    if audio.dtype != np.float32 or audio.ndim != 2 or audio.shape[0] not in (1, 2) or not np.isfinite(audio).all():
        raise ValueError("Plugin input must be finite mono/stereo float32 audio.")
    sr = job.get("sr")
    if type(sr) not in (float, int) or not 8000 <= sr <= 192000:
        raise ValueError("Unsupported plugin sample rate.")
    plugin = load_effect(entry)
    if plugin.is_instrument:
        raise ValueError("The plugin rack accepts audio effects only.")
    plugin.reset()
    plugin.raw_state = state
    for key, value in values.items():
        setattr(plugin, key, value)
    frames = audio.shape[1]
    if not frames:
        result = audio
    else:
        # Pedalboard compensates reported latency. Buffered effects can emit
        # fewer frames on the first call; silence flushes only that deficit.
        # The DAW renders the full history, including silence between clips,
        # and owns the timeline length. Never append a tail to a region file.
        result = plugin(audio, float(sr), reset=False)
        for _ in range(16):
            if result.shape[1] >= frames:
                break
            silence = np.zeros((audio.shape[0], min(max(frames - result.shape[1], 512), int(sr * 2))), dtype=np.float32)
            more = plugin(silence, float(sr), reset=False)
            result = np.concatenate((result, more), axis=1)
        if result.shape[1] < frames:
            raise ValueError("Plugin did not return all requested audio frames.")
        result = result[:, :frames]
    if result.shape != audio.shape or not np.isfinite(result).all():
        raise ValueError("Plugin returned invalid audio or an unsupported channel layout.")
    target = Path(job["output"])
    with target.open("xb") as handle:
        np.save(handle, np.asarray(result, dtype=np.float32), allow_pickle=False)
    return {"ok": True, "latencySamples": int(getattr(plugin, "reported_latency_samples", 0)), "frames": frames}


def extract_zip(job):
    source, destination = Path(job["input"]), Path(job["output"])
    if source.stat().st_size > 256 * 1024 * 1024:
        raise ValueError("Plugin ZIP exceeds 256 MiB.")
    destination.mkdir(exist_ok=False)
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > MAX_FILES:
            raise ValueError("Plugin ZIP is empty or contains too many entries.")
        names, total = set(), 0
        for info in entries:
            name = info.orig_filename.rstrip("/")
            parts = name.split("/")
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (not name or len(name) > 1024 or "\\" in name or any(ord(c) < 32 for c in name)
                    or ":" in name or name.startswith("/") or any(p in ("", ".", "..") or p.endswith((".", " ")) for p in parts)
                    or any(re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", p, re.I) for p in parts)
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1):
                raise ValueError("Unsafe or unsupported entry in plugin ZIP.")
            folded = name.casefold()
            if folded in names:
                raise ValueError("Duplicate paths in plugin ZIP.")
            names.add(folded)
            total += info.file_size
            if total > MAX_BUNDLE_BYTES or info.file_size > MAX_BUNDLE_BYTES or (info.file_size > 1024 * 1024 and info.file_size > max(1, info.compress_size) * 1000):
                raise ValueError("Plugin ZIP exceeds its expansion limit.")
        # Validate every entry before writing any file. Fresh destination has
        # no links or existing files; ZIP links/device files are refused above.
        for info in entries:
            mode = info.external_attr >> 16
            target = destination.joinpath(*info.filename.rstrip("/").split("/"))
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with archive.open(info) as src, target.open("xb") as out:
                for block in iter(lambda: src.read(1024 * 1024), b""):
                    written += len(block)
                    if written > info.file_size:
                        raise ValueError("Plugin ZIP entry exceeded its declared size.")
                    out.write(block)
            if written != info.file_size:
                raise ValueError("Incomplete plugin ZIP entry.")
            if os.name != "nt" and mode & 0o111:
                target.chmod(0o755)
    return {"ok": True, "entries": len(entries), "bytes": total}


def main(job):
    op = job.get("op")
    if op == "extract":
        return extract_zip(job)
    if op == "inspect":
        return inspect_plugin(job)
    if op == "process":
        return process_plugin(job)
    if op == "probe":
        import importlib.metadata
        import numpy
        import pedalboard
        return {"ok": True, "ready": True, "version": importlib.metadata.version("pedalboard"), "numpyVersion": numpy.__version__}
    raise ValueError("Unknown plugin worker operation.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        file = Path(args.request)
        if file.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("Plugin request exceeds its size limit.")
        result = main(json.loads(file.read_text(encoding="utf-8")))
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:2000]}))
        sys.exit(1)
