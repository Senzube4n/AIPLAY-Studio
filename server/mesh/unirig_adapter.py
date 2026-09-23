"""Offline, argv-only adapter for the public UniRig five-stage inference flow.

No packages or weights are installed here. A successful prerequisite probe is
not an end-to-end model validation; each actual run must produce a skinned GLB.
"""
import argparse
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

MARKER = "UNIRIG_RESULT_JSON:"
TASKS = {
    "skeleton": "configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml",
    "skin": "configs/task/quick_inference_unirig_skin.yaml",
}
CHECKPOINTS = {
    "skeleton": "skeleton/articulation-xl_quantization_256/model.ckpt",
    "skin": "skin/articulation-xl/model.ckpt",
}
# Native inference is opt-in and tested against these upstream source contracts
# (UniRig 6793c6640ff01c8fb389f3993434124bb43d2933). Normalize line endings before
# hashing so a Windows checkout and a source archive have the same contract.
NATIVE_SOURCE_HASHES = {
    "src/data/extract.py": "f31041bb2da7286ba431541602b5fe7218b52a4b0cf4272d46029164a0138891",
    "src/model/unirig_skin.py": "68bd4134462997d945c7f535a5787d93b10c3b65240de5b4d187624f61bfcf9a",
    "src/model/pointcept/models/PTv3Object.py": "32ea574f3d4fa85ebdb7e74f3549f1637745e6b68739adfc91110bcb07e20ced",
    "configs/model/unirig_ar_350m_1024_81920_float32.yaml": "5baa90902a4ae8ef64693df612646df149543d410290f5a48b1db0442111f511",
}


def attention_backend():
    backend = os.environ.get("AIPLAY_UNIRIG_ATTENTION", "flash_attention_2")
    if backend not in ("flash_attention_2", "sdpa"):
        raise ValueError("AIPLAY_UNIRIG_ATTENTION must be flash_attention_2 or sdpa")
    return backend


def native_source_contract(repo):
    for rel, expected in NATIVE_SOURCE_HASHES.items():
        source = (Path(repo) / rel).read_text(encoding="utf-8")
        if hashlib.sha256(source.encode("utf-8")).hexdigest() != expected:
            raise RuntimeError("Native UniRig source contract changed: " + rel
                               + "; use the tested upstream revision or revalidate this adapter")


def prepare_native_runtime(repo, target):
    """Adapt only a private source copy; never install or impersonate flash_attn."""
    repo, target = Path(repo), Path(target)
    native_source_contract(repo)
    target.mkdir(parents=True, exist_ok=False)
    for directory in ("src", "configs"):
        shutil.copytree(repo / directory, target / directory,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copyfile(repo / "run.py", target / "run.py")
    if (repo / "LICENSE").is_file():
        shutil.copyfile(repo / "LICENSE", target / "LICENSE")

    def replace(rel, old, new):
        file = target / rel
        source = file.read_text(encoding="utf-8")
        if source.count(old) != 1:
            raise RuntimeError("Native UniRig source pattern changed: " + rel)
        file.write_text(source.replace(old, new), encoding="utf-8")

    replace("src/data/extract.py", 'for file in inputs:\n            file_name = file.removeprefix("./")',
            "for file in inputs:\n            file_name = os.path.basename(file)")
    replace("src/model/unirig_skin.py", "from flash_attn.modules.mha import MHA",
            "from .aiplay_native_attention import NativeCrossMHA as MHA")
    replace("configs/model/unirig_ar_350m_1024_81920_float32.yaml",
            "_attn_implementation: flash_attention_2", "_attn_implementation: sdpa")
    replace("src/model/pointcept/models/PTv3Object.py", "    flash_attn = None",
            "    flash_attn = None\nfrom ...aiplay_native_attention import native_varlen_qkvpacked")
    replace("src/model/pointcept/models/PTv3Object.py",
            '            assert flash_attn is not None, "Make sure flash_attn is installed."',
            "            # Explicit native SDPA keeps the original ragged partitions.")
    replace("src/model/pointcept/models/PTv3Object.py", "flash_attn.flash_attn_varlen_qkvpacked_func(",
            "native_varlen_qkvpacked(")
    shutil.copyfile(Path(__file__).with_name("unirig_native_attention.py"),
                    target / "src/model/aiplay_native_attention.py")
    return target
IMPORTS = {
    "torch": "PyTorch inference runtime",
    "bpy": "Blender mesh extraction and skin transfer",
    "flash_attn.modules.mha": "skin cross-attention and skeleton FlashAttention",
    "spconv.pytorch": "PointTransformer sparse convolution",
    "torch_scatter": "skin and mesh encoder scatter operations",
    "torch_cluster": "Michelangelo farthest-point sampling",
    "lightning": "upstream inference trainer",
    "box": "upstream YAML configuration objects (python-box)",
    "yaml": "upstream configuration parser (PyYAML)",
    "omegaconf": "mesh encoder configuration",
    "transformers": "skeleton autoregressive model",
    "trimesh": "mesh geometry",
    "open3d": "upstream geometry utilities",
    "fast_simplification": "extraction mesh simplification",
}


def offline_env():
    return {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
            "WANDB_MODE": "disabled", "PYTHONDONTWRITEBYTECODE": "1"}


def locations():
    repo = Path(os.environ.get("AIPLAY_UNIRIG", "")).resolve()
    weights = Path(os.environ.get("AIPLAY_MESH_WEIGHTS", "")).resolve() / "UniRig"
    return repo, weights


def probe():
    """Import prerequisites without loading model weights or allocating tensors."""
    repo, weights = locations()
    missing, versions = [], {}
    backend = "invalid"

    def fail(module, error, why):
        missing.append({"module": module, "error": str(error), "why": why})

    try:
        backend = attention_backend()
        if backend == "sdpa":
            native_source_contract(repo)
    except Exception as exc:
        fail("attention backend", str(exc), "Native SDPA is an explicit experimental adapter for the tested source revision.")

    versions["python"] = ".".join(map(str, sys.version_info[:3]))
    if sys.version_info[:2] != (3, 11):
        fail("python", versions["python"], "This adapter targets upstream's documented Python 3.11 stack; set AIPLAY_UNIRIG_PYTHON to a separate compatible interpreter.")
    for rel in ["run.py", "src/data/extract.py", "src/inference/merge.py", "configs/data/quick_inference.yaml", *TASKS.values()]:
        if not (repo / rel).is_file():
            fail("repository", str(repo / rel), "Required UniRig source is absent; set AIPLAY_UNIRIG.")
    for name, rel in CHECKPOINTS.items():
        file = weights / rel
        if not file.is_file() or file.stat().st_size < 1024:
            fail(name + " checkpoint", str(file), "A complete local checkpoint is required; this adapter never downloads weights.")
    for module, why in IMPORTS.items():
        if module == "flash_attn.modules.mha" and backend == "sdpa":
            continue
        try:
            importlib.import_module(module)
        except Exception as exc:
            fail(module, type(exc).__name__ + ": " + str(exc), why)
    for dist, wanted in [("transformers", "4.51.3"), ("numpy", "1.26.4"), ("bpy", "4.2")]:
        try:
            actual = importlib.metadata.version(dist)
            versions[dist] = actual
            if actual != wanted and not (dist == "bpy" and actual.startswith("4.2.")):
                fail(dist + " version", actual, "The supported upstream configuration requires " + wanted + "; use an isolated UniRig environment.")
        except importlib.metadata.PackageNotFoundError:
            pass  # The import failure above is the useful diagnostic.
    try:
        versions["torch"] = importlib.metadata.version("torch")
        if backend == "sdpa" and versions["torch"].split("+")[0] != "2.5.1":
            fail("native torch version", versions["torch"], "The native backend was measured with torch 2.5.1; use an isolated compatible runtime.")
        torch = sys.modules.get("torch")
        if torch is not None and not torch.version.cuda:
            fail("CUDA", "CPU-only PyTorch", "Both upstream inference tasks require an NVIDIA CUDA runtime.")
    except importlib.metadata.PackageNotFoundError:
        pass
    # This is configuration metadata only, not pretrained OPT model weights.
    try:
        from transformers import AutoConfig
        AutoConfig.from_pretrained("facebook/opt-350m", local_files_only=True)
    except Exception as exc:
        fail("OPT configuration", type(exc).__name__ + ": " + str(exc), "Cache facebook/opt-350m/config.json in the separate runtime before running; network access is disabled during inference.")
    if not missing:
        # Exercise the real entry-point import graph, still without main/model construction.
        with tempfile.TemporaryDirectory(prefix="aiplay-unirig-probe-") as temp:
            checked_repo = repo
            try:
                import runpy
                if backend == "sdpa":
                    checked_repo = prepare_native_runtime(repo, Path(temp) / "runtime")
                sys.path.insert(0, str(checked_repo))
                runpy.run_path(str(checked_repo / "run.py"), run_name="_aiplay_unirig_import_probe")
            except Exception as exc:
                fail("upstream entry point", type(exc).__name__ + ": " + str(exc), "run.py must import successfully before any model inference.")
            finally:
                if sys.path[0] == str(checked_repo):
                    sys.path.pop(0)
    return {"canRig": not missing, "missing": missing, "python": versions["python"],
            "executable": sys.executable, "versions": versions,
            "invocationImplemented": True, "endToEndValidated": False,
            "validation": "prerequisite imports and local configuration only; no GPU model run",
            "attentionBackend": backend, "experimental": backend == "sdpa",
            "offline": True, "stages": ["extract", "skeleton", "extract-skeleton", "skin", "merge"]}


def write_task(repo, stage, work, weights):
    """Override only the checkpoint and log root in a private task YAML."""
    source = (repo / TASKS[stage]).read_text(encoding="utf-8")
    checkpoint = str((weights / CHECKPOINTS[stage]).resolve())
    source, count = re.subn(r"(?m)^resume_from_checkpoint:.*$", lambda _: "resume_from_checkpoint: " + json.dumps(checkpoint), source)
    if count != 1:
        raise RuntimeError("UniRig task contract changed: expected one resume_from_checkpoint")
    source, count = re.subn(r"(?m)^trainer:\s*$", lambda _: "trainer:\n  default_root_dir: " + json.dumps(str(work)), source)
    if count != 1:
        raise RuntimeError("UniRig task contract changed: expected one trainer")
    target = work / (stage + "-task.yaml")
    target.write_text(source, encoding="utf-8")
    return target


def stage_plan(python, repo, weights, source, work, seed=42):
    """Translate launch/inference/*.sh into argument arrays, without shell/pip."""
    source, work = Path(source), Path(work)
    skeleton, skin = work / "skeleton.fbx", work / "skin.fbx"
    npz_mesh, npz_skin = work / "mesh-data", work / "skin-data"
    skeleton_task = write_task(repo, "skeleton", work, weights)
    skin_task = write_task(repo, "skin", work, weights)
    common = ["--require_suffix=obj,fbx,FBX,dae,glb,gltf,vrm", "--num_runs=1", "--id=0"]

    def extract(name, input_path, output_dir):
        return {"id": name, "argv": [python, "-u", "-m", "src.data.extract",
                "--config=configs/data/quick_inference.yaml", *common,
                "--force_override=true", "--faces_target_count=50000", "--time=aiplay",
                "--input=" + str(input_path), "--output_dir=" + str(output_dir)],
                "expected": output_dir / input_path.stem / "raw_data.npz"}

    return [
        extract("extract", source, npz_mesh),
        {"id": "skeleton", "argv": [python, "-u", "run.py", "--task=" + str(skeleton_task),
            "--seed=" + str(seed), "--input=" + str(source), "--output=" + str(skeleton),
            "--npz_dir=" + str(npz_mesh)], "expected": skeleton},
        extract("extract-skeleton", skeleton, npz_skin),
        {"id": "skin", "argv": [python, "-u", "run.py", "--task=" + str(skin_task),
            "--seed=" + str(seed), "--input=" + str(skeleton), "--output=" + str(skin),
            "--npz_dir=" + str(npz_skin), "--data_name=raw_data.npz"], "expected": skin},
        {"id": "merge", "argv": [python, "-u", "-m", "src.inference.merge", *common,
            "--source=" + str(skin), "--target=" + str(source),
            "--output=" + str(work / "rigged.glb")], "expected": work / "rigged.glb"},
    ]


# ── THE SKIN GATE ───────────────────────────────────────────────────────────
#
# ⚠ WHY THIS IS NO LONGER AN INDEX CHECK.
#
# validate_skinned_glb() is the last thing standing between UniRig's output and
# the os.replace() below it, and the rig path is IN PLACE: server/mesh/runner.js
# passes `--glb X --out X`, so the file that passes here overwrites the user's
# only copy of their mesh.
#
# The earlier version asserted that POSITION, JOINTS_0 and WEIGHTS_0 resolved to
# in-range accessor INDICES and never opened the BIN chunk at all. A GLB whose
# every vertex weight is zero — a mesh bound to nothing, which collapses the
# moment it is posed — has perfectly valid indices. It passed, and the original
# mesh was destroyed by a rig that had not rigged anything.
#
# server/mesh/glb.js already reads the bytes on the JavaScript side (76 named
# cases in glb_skin_test.js). This is that decoder in Python: componentType,
# `normalized` and `byteStride` are honoured, sparse accessors are resolved, the
# joint hierarchy has to be acyclic with a common root, bind matrices have to be
# affine and invertible, and every vertex's weights must sum to one over joints
# that exist in the skin. It verifies BINDING, not anatomy — a rig can pass here
# and still look wrong, which is why the returned `validation` says so.
#
# Every refusal names what was wrong. "No structurally usable skinned mesh" is
# kept for the one case where that IS the whole answer (a mesh no node binds);
# anything else would send somebody to re-run a rig without telling them which
# half of it failed.
GLB_MAGIC = struct.unpack("<I", b"glTF")[0]
CHUNK_JSON = struct.unpack("<I", b"JSON")[0]
CHUNK_BIN = struct.unpack("<I", b"BIN\0")[0]
# A glTF scene description is text; 64 MB of it is a header that is lying.
MAX_JSON_BYTES = 64 * 1024 * 1024
# A corrupt sparse accessor may claim billions of implicit vertices. Bound the
# synchronous work as well as the byte ranges, and refuse rather than half-check.
MAX_ACCESSOR_COUNT = 5_000_000
MAX_VALIDATION_COMPONENTS = 100_000_000
# componentType -> (struct format, byte width, normalization divisor)
COMPONENTS = {5121: ("<B", 1, 255.0), 5123: ("<H", 2, 65535.0),
              5125: ("<I", 4, 4294967295.0), 5126: ("<f", 4, 1.0)}
WIDTHS = {"SCALAR": 1, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def require(condition, why):
    if not condition:
        raise RuntimeError("UniRig output is not usably skinned: " + why)


def _uint(value):
    return type(value) is int and value >= 0


def _ref(items, index):
    return isinstance(items, list) and _uint(index) and index < len(items) and isinstance(items[index], dict)


def read_glb(file):
    """Split a GLB into its glTF document and its BIN chunk, trusting no length."""
    raw = Path(file).read_bytes()
    if len(raw) < 20:
        raise RuntimeError("UniRig output is not a complete GLB")
    magic, version, total = struct.unpack_from("<III", raw, 0)
    # Three DIFFERENT faults, named separately because they mean different things
    # to whoever reads the refusal. glb.js already separates them; collapsing them
    # here made the Python gate the less informative half of a deliberate port.
    # The one that matters most is the length mismatch: a truncated write is what
    # an interrupted subprocess leaves behind, and reported as "invalid header" it
    # reads as "UniRig emitted garbage" rather than "the run was cut short".
    # raise, not require(): require() prefixes "is not usably skinned", and a
    # truncated container is not a skinning verdict at all — nothing was read yet.
    if magic != GLB_MAGIC:
        raise RuntimeError("UniRig output is not a GLB: the first four bytes are not \"glTF\"")
    if version != 2:
        raise RuntimeError("UniRig output has an invalid GLB header: container version "
                           + str(version) + ", expected 2")
    if total != len(raw):
        raise RuntimeError("UniRig output has an invalid GLB header: the container declares "
                           + str(total) + " bytes and the file is " + str(len(raw)))
    offset, document, binary, index = 12, None, None, 0
    while offset + 8 <= len(raw):
        length, kind = struct.unpack_from("<II", raw, offset)
        if offset + 8 + length > len(raw):
            raise RuntimeError("UniRig output has a GLB chunk claiming more bytes than the file holds")
        if length % 4 or (index == 0 and kind != CHUNK_JSON) or (kind == CHUNK_JSON and index != 0) \
                or (kind == CHUNK_BIN and (index != 1 or binary is not None)):
            raise RuntimeError("UniRig output has an invalid GLB chunk order or alignment: "
                               "JSON must be first, BIN second, each at most once and 4-byte aligned")
        if kind == CHUNK_JSON:
            if length > MAX_JSON_BYTES:
                raise RuntimeError("UniRig output's JSON chunk is past this reader's ceiling")
            document = json.loads(raw[offset + 8:offset + 8 + length])
        elif kind == CHUNK_BIN:
            binary = raw[offset + 8:offset + 8 + length]
        offset += 8 + length
        index += 1
    if offset != len(raw):
        raise RuntimeError("UniRig output ends with an incomplete GLB chunk header")
    if not isinstance(document, dict):
        raise RuntimeError("UniRig output carries no glTF JSON chunk")
    return document, binary


def buffer_view(document, binary, index, label):
    """Only the uncompressed embedded buffer is decoded; no external file is read."""
    views = document.get("bufferViews")
    require(_ref(views, index), label + ": bufferView " + str(index) + " does not exist")
    view = views[index]
    buffers = document.get("buffers")
    require(view.get("buffer") == 0 and _ref(buffers, 0), label + ": buffer must reference embedded buffer 0")
    require("uri" not in buffers[0],
            label + ": external or data-URI buffers are not verified; embed the skin data in the GLB BIN chunk")
    require(not (view.get("extensions") or {}).get("EXT_meshopt_compression"),
            label + ": a compressed bufferView is not supported by this skin gate")
    length, offset, size = buffers[0].get("byteLength"), view.get("byteOffset", 0), view.get("byteLength")
    require(_uint(length) and 0 < length <= len(binary) and len(binary) - length <= 3,
            label + ": embedded buffer byteLength disagrees with the BIN chunk")
    require(_uint(offset) and _uint(size) and size > 0 and offset <= length and size <= length - offset,
            label + ": bufferView byte range exceeds the embedded buffer")
    return {**view, "byteOffset": offset}


def skin_accessor(document, binary, index, label, kind, types, normalized=False, vertex=False):
    """Decode one accessor, honouring componentType, normalization, stride and sparse."""
    accessors = document.get("accessors")
    require(_ref(accessors, index), label + ": accessor " + str(index) + " does not exist")
    a = accessors[index]
    require(a.get("type") == kind, label + ": accessor is " + str(a.get("type") or "untyped") + ", not " + kind)
    require(a.get("componentType") in types, label + ": unsupported componentType " + str(a.get("componentType")))
    require(type(a.get("normalized", False)) is bool, label + ": normalized must be a boolean")
    needs = normalized and a["componentType"] != 5126
    require(bool(a.get("normalized", False)) == needs,
            label + (": integer weights must be normalized" if needs
                     else ": normalized is not allowed for this accessor"))
    count = a.get("count")
    require(_uint(count) and 0 < count <= MAX_ACCESSOR_COUNT,
            label + ": accessor count must be a positive integer no greater than " + str(MAX_ACCESSOR_COUNT))
    fmt, width, divisor = COMPONENTS[a["componentType"]]
    size = width * WIDTHS[kind]
    offset = a.get("byteOffset", 0)
    require(_uint(offset) and offset % width == 0 and (not vertex or offset % 4 == 0),
            label + ": misaligned or invalid accessor byteOffset")
    base, stride = None, size
    if a.get("bufferView") is not None:
        view = buffer_view(document, binary, a["bufferView"], label)
        require((view["byteOffset"] + offset) % width == 0,
                label + ": bufferView/accessor component alignment is invalid")
        if view.get("byteStride") is not None:
            require(vertex and _uint(view["byteStride"]) and size <= view["byteStride"] <= 252
                    and view["byteStride"] % 4 == 0,
                    label + ": invalid byteStride (only vertex attributes may be interleaved)")
            stride = view["byteStride"]
        require(offset <= view["byteLength"] and size <= view["byteLength"] - offset
                and (count - 1) * stride <= view["byteLength"] - offset - size,
                label + ": accessor byte range exceeds its bufferView")
        base = view["byteOffset"] + offset
    else:
        require(offset == 0, label + ": byteOffset requires a bufferView")
        require(isinstance(a.get("sparse"), dict), label + ": accessor has neither binary data nor sparse values")
    sparse, sparse_base = None, 0
    if a.get("sparse") is not None:
        s = a["sparse"]
        require(isinstance(s, dict) and _uint(s.get("count")) and 0 < s["count"] <= count,
                label + ": invalid sparse count")
        require(isinstance(s.get("indices"), dict) and isinstance(s.get("values"), dict)
                and s["indices"].get("componentType") in (5121, 5123, 5125),
                label + ": invalid sparse indices or values")
        ifmt, iwidth, _ = COMPONENTS[s["indices"]["componentType"]]
        iv = buffer_view(document, binary, s["indices"].get("bufferView"), label + " sparse indices")
        vv = buffer_view(document, binary, s["values"].get("bufferView"), label + " sparse values")
        io, vo = s["indices"].get("byteOffset", 0), s["values"].get("byteOffset", 0)
        require(iv.get("byteStride") is None and vv.get("byteStride") is None
                and iv.get("target") is None and vv.get("target") is None,
                label + ": sparse bufferViews must not have target or byteStride")
        require(_uint(io) and io % iwidth == 0 and (iv["byteOffset"] + io) % iwidth == 0
                and io <= iv["byteLength"] and s["count"] * iwidth <= iv["byteLength"] - io,
                label + ": sparse index byte range or alignment is invalid")
        require(_uint(vo) and vo % width == 0 and (vv["byteOffset"] + vo) % width == 0
                and vo <= vv["byteLength"] and s["count"] * size <= vv["byteLength"] - vo,
                label + ": sparse value byte range or alignment is invalid")
        sparse, sparse_base, last = {}, vv["byteOffset"] + vo, -1
        for i in range(s["count"]):
            j = struct.unpack_from(ifmt, binary, iv["byteOffset"] + io + i * iwidth)[0]
            require(last < j < count,
                    label + ": sparse indices must be strictly increasing and within accessor count")
            sparse[j] = i
            last = j

    def at(i, k):
        replaced = None if sparse is None else sparse.get(i)
        if replaced is not None:
            address = sparse_base + replaced * size
        elif base is None:
            return 0.0 if needs else 0
        else:
            address = base + i * stride
        value = struct.unpack_from(fmt, binary, address + k * width)[0]
        return value / divisor if needs else value

    return {"count": count, "componentType": a["componentType"], "at": at}


def node_hierarchy(nodes):
    """Skin transforms need an acyclic, unambiguously parented node tree."""
    parent = {}
    for i, node in enumerate(nodes):
        children = node.get("children") if isinstance(node, dict) else None
        if children is None:
            continue
        require(isinstance(children, list), "node " + str(i) + " children is not an array")
        for child in children:
            require(_ref(nodes, child), "node " + str(i) + " has a child reference that is not a node")
            require(child not in parent, "node " + str(child) + " has duplicate or multiple parents")
            parent[child] = i
    roots = {}
    for i in range(len(nodes)):
        path, n = [], i
        while n in parent and n not in roots:
            require(n not in path, "the node hierarchy contains a cycle at node " + str(n))
            path.append(n)
            n = parent[n]
        root = roots.get(n, n)
        roots[i] = root
        for child in path:
            roots[child] = root

    def descendants_of(root):
        seen, stack = set(), [root]
        while stack:
            n = stack.pop()
            seen.add(n)
            children = nodes[n].get("children") if isinstance(nodes[n], dict) else None
            for child in children or []:
                stack.append(child)
        return seen

    return roots, descendants_of


def validate_bind_matrices(document, binary, skin, index, spend):
    label = "skin " + str(index) + " inverseBindMatrices"
    require(_ref(document.get("accessors"), skin.get("inverseBindMatrices")),
            "skin " + str(index) + " has no inverseBindMatrices accessor — glTF permits that "
            "and the downstream requires an explicit bind pose")
    # Counted BEFORE the accessor is decoded, so a joint/matrix mismatch is
    # reported as the mismatch it is rather than as a byte range that overran.
    declared = document["accessors"][skin["inverseBindMatrices"]].get("count")
    require(declared == len(skin["joints"]),
            "skin " + str(index) + " has " + str(len(skin["joints"])) + " joints and "
            + str(declared) + " bind matrices")
    a = skin_accessor(document, binary, skin["inverseBindMatrices"], label, "MAT4", (5126,))
    require(a["count"] == len(skin["joints"]),
            "skin " + str(index) + " has " + str(len(skin["joints"])) + " joints and "
            + str(a["count"]) + " bind matrices")
    spend(a["count"] * 16)
    for j in range(a["count"]):
        m = [a["at"](j, k) for k in range(16)]
        require(all(math.isfinite(v) for v in m),
                "skin " + str(index) + " bind matrix " + str(j) + " contains a non-finite component")
        require(m[3] == 0 and m[7] == 0 and m[11] == 0 and m[15] == 1,
                "skin " + str(index) + " bind matrix " + str(j)
                + " is not affine (fourth row must be 0, 0, 0, 1)")
        det = (m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
               + m[8] * (m[1] * m[6] - m[5] * m[2]))
        require(math.isfinite(det) and det != 0,
                "skin " + str(index) + " bind matrix " + str(j)
                + " is singular and cannot bind a usable pose")


def validate_primitive(document, binary, primitive, label, joint_count, spend):
    """Decode every vertex of one primitive; an unbound vertex is a refusal."""
    require(isinstance(primitive, dict) and isinstance(primitive.get("attributes"), dict),
            label + ": missing primitive attributes")
    require(not (primitive.get("extensions") or {}).get("KHR_draco_mesh_compression"),
            label + ": Draco-compressed skin data is not supported by this skin gate")
    attributes = primitive["attributes"]
    require("JOINTS_0" in attributes and "WEIGHTS_0" in attributes,
            label + ": JOINTS_0 and WEIGHTS_0 are required to bind vertices")
    position = skin_accessor(document, binary, attributes.get("POSITION"),
                             label + " POSITION", "VEC3", (5126,), vertex=True)
    names = [k for k in attributes if re.match(r"^(JOINTS|WEIGHTS)_", k)]
    require(all(re.match(r"^(JOINTS|WEIGHTS)_(0|[1-9]\d*)$", k) for k in names),
            label + ": invalid skin attribute set name")
    sets = sorted({int(k.split("_")[1]) for k in names})
    require(all(s == i for i, s in enumerate(sets)), label + ": skin attribute sets must be contiguous from 0")
    spend(position["count"] * (3 + len(sets) * 8))
    pairs = []
    for s in sets:
        require("JOINTS_%d" % s in attributes and "WEIGHTS_%d" % s in attributes,
                label + ": JOINTS_%d and WEIGHTS_%d must be paired" % (s, s))
        joints = skin_accessor(document, binary, attributes["JOINTS_%d" % s],
                               "%s JOINTS_%d" % (label, s), "VEC4", (5121, 5123), vertex=True)
        weights = skin_accessor(document, binary, attributes["WEIGHTS_%d" % s],
                                "%s WEIGHTS_%d" % (label, s), "VEC4", (5121, 5123, 5126),
                                normalized=True, vertex=True)
        require(joints["count"] == position["count"] and weights["count"] == position["count"],
                label + ": POSITION/JOINTS_%d/WEIGHTS_%d vertex counts differ" % (s, s))
        pairs.append((joints, weights))
    quantized = all(w["componentType"] != 5126 for _, w in pairs)
    for v in range(position["count"]):
        require(all(math.isfinite(position["at"](v, k)) for k in range(3)),
                label + ": POSITION vertex " + str(v) + " contains a non-finite component")
        total, nonzero, used = 0.0, 0, set()
        for joints, weights in pairs:
            for k in range(4):
                joint, weight = joints["at"](v, k), weights["at"](v, k)
                require(joint < joint_count,
                        label + ": vertex " + str(v) + " references joint " + str(joint)
                        + ", outside skin.joints (" + str(joint_count) + ")")
                require(math.isfinite(weight) and 0 <= weight <= 1,
                        label + ": vertex " + str(v) + " has a non-finite or out-of-range weight")
                if weight > 0:
                    require(joint not in used,
                            label + ": vertex " + str(v)
                            + " assigns more than one non-zero weight to joint " + str(joint))
                    used.add(joint)
                    nonzero += 1
                total += weight
        # The Khronos validator's float tolerance. A quantized sum must total one
        # exactly; a missing integer quantum is far larger than this tolerance.
        tolerance = 1e-12 if quantized else 2e-7 * nonzero
        require(nonzero > 0 and abs(total - 1) <= tolerance,
                label + ": vertex " + str(v) + " weights sum to " + repr(total)
                + ", expected 1 (no unweighted vertices)")
    if primitive.get("indices") is not None:
        index = skin_accessor(document, binary, primitive["indices"], label + " indices",
                              "SCALAR", (5121, 5123, 5125))
        spend(index["count"])
        for i in range(index["count"]):
            require(index["at"](i, 0) < position["count"],
                    label + ": index " + str(i) + " is outside the POSITION vertex count")
    return position["count"]


def validate_skinned_glb(file):
    """Read the bytes of every mesh-bound skin before an existing mesh is replaced.

    Refuses — never returns — when a vertex is unweighted, a weight set does not
    sum to one, a joint index falls outside the skin, or a primitive claims a
    skin without both attributes. Binding only; deformation quality is separate.
    """
    document, binary = read_glb(file)
    nodes = document.get("nodes") if isinstance(document.get("nodes"), list) else []
    meshes = document.get("meshes") if isinstance(document.get("meshes"), list) else []
    skins = document.get("skins") if isinstance(document.get("skins"), list) else []
    uses = {}
    for i, node in enumerate(nodes):
        if not isinstance(node, dict) or node.get("skin") is None:
            continue
        require(_ref(skins, node["skin"]), "node " + str(i) + " references a skin that does not exist")
        require(_ref(meshes, node.get("mesh")),
                "node " + str(i) + " uses skin " + str(node["skin"])
                + " but its mesh reference does not exist")
        uses.setdefault(node["skin"], set()).add(node["mesh"])
    if not uses:
        # The one case where "no usable skin" IS the whole answer.
        raise RuntimeError("UniRig output has no structurally usable skinned mesh")
    require(isinstance(binary, (bytes, bytearray)) and len(binary) > 0,
            "the GLB carries no BIN chunk, so no vertex is actually bound to anything")
    roots, descendants_of = node_hierarchy(nodes)
    spent = [0]

    def spend(n):
        spent[0] += n
        require(spent[0] <= MAX_VALIDATION_COMPONENTS,
                "skin validation exceeds the " + str(MAX_VALIDATION_COMPONENTS) + "-component work limit")

    joint_total, vertices, primitives = 0, 0, 0
    for index in sorted(uses):
        skin = skins[index]
        joints = skin.get("joints")
        require(isinstance(joints, list) and len(joints) > 0, "skin " + str(index) + " has no joints")
        joint_total = max(joint_total, len(joints))
        require(all(_ref(nodes, j) for j in joints),
                "skin " + str(index) + " has a joint index that is not a node")
        require(len(set(joints)) == len(joints), "skin " + str(index) + " has duplicate joint nodes")
        require(skin.get("skeleton") is None or _ref(nodes, skin["skeleton"]),
                "skin " + str(index) + " skeleton references a node that does not exist")
        require(all(roots.get(j) == roots.get(joints[0]) for j in joints),
                "skin " + str(index) + " joints have no common root in the node hierarchy")
        if skin.get("skeleton") is not None:
            family = descendants_of(skin["skeleton"])
            spend(len(family))
            require(all(j in family for j in joints),
                    "skin " + str(index) + " skeleton is not an ancestor of every joint")
        validate_bind_matrices(document, binary, skin, index, spend)
        for mesh in sorted(uses[index]):
            parts = meshes[mesh].get("primitives")
            require(isinstance(parts, list) and len(parts) > 0,
                    "skin " + str(index) + " mesh " + str(mesh) + " has no primitives")
            for p, primitive in enumerate(parts):
                vertices += validate_primitive(
                    document, binary, primitive,
                    "skin %d mesh %d primitive %d" % (index, mesh, p), len(joints), spend)
                primitives += 1
    return {"joints": joint_total, "vertices": vertices, "primitives": primitives,
            "verifiedSkins": len(uses),
            "validation": "decoded BIN chunk: bind matrices, joint indices and per-vertex weights "
                          "of every mesh-bound skin; deformation quality needs review"}


def run_stages(source, output, repo, weights, python=sys.executable, seed=42, executor=subprocess.run):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source.suffix.lower() != ".glb" or not source.is_file() or output.suffix.lower() != ".glb":
        raise ValueError("UniRig needs an existing input GLB and an output .glb path")
    output.parent.mkdir(parents=True, exist_ok=True)
    started, stages = time.monotonic(), []
    # The output's filesystem is used so os.replace is atomic even for in-place rigging.
    with tempfile.TemporaryDirectory(prefix=".unirig-", dir=output.parent) as temp:
        work = Path(temp)
        backend = attention_backend()
        runtime = prepare_native_runtime(repo, work / "runtime") if backend == "sdpa" else repo
        staged_source = work / "source.glb"
        shutil.copyfile(source, staged_source)
        for stage in stage_plan(python, runtime, weights, staged_source, work, seed):
            begin = time.monotonic()
            print("[unirig] " + stage["id"], file=sys.stderr, flush=True)
            executor(stage["argv"], cwd=str(runtime), env=offline_env(), check=True)
            if not stage["expected"].is_file() or stage["expected"].stat().st_size == 0:
                raise RuntimeError("UniRig " + stage["id"] + " finished without its expected artifact: " + str(stage["expected"]))
            stages.append({"stage": stage["id"], "seconds": round(time.monotonic() - begin, 3)})
        checked = validate_skinned_glb(work / "rigged.glb")
        os.replace(work / "rigged.glb", output)
    return {"rigSeconds": round(time.monotonic() - started, 3), "rigStages": stages,
            "rigSeed": seed, "rigRuntime": python, "rigValidation": checked, "rigOffline": True,
            "rigAttentionBackend": backend, "rigExperimental": backend == "sdpa"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--attention", choices=("flash_attention_2", "sdpa"),
                        help="explicit experimental SDPA uses a verified private source copy")
    args = parser.parse_args()
    if args.attention:
        os.environ["AIPLAY_UNIRIG_ATTENTION"] = args.attention
    os.environ.update({k: v for k, v in offline_env().items() if k in ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "WANDB_MODE", "PYTHONDONTWRITEBYTECODE"]})
    measured = probe()
    if args.probe:
        print(MARKER + json.dumps(measured), flush=True)
        return 0
    if not measured["canRig"]:
        print("REFUSED: UniRig prerequisites failed: " + json.dumps(measured), file=sys.stderr)
        return 2
    if not args.input or not args.output:
        parser.error("--input and --output are required for inference")
    repo, weights = locations()
    result = run_stages(args.input, args.output, repo, weights, seed=args.seed)
    print(MARKER + json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
