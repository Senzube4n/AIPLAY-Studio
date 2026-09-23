"""Dependency-independent regression tests for the real UniRig orchestration.

Run: python server/mesh/unirig_adapter_test.py
The executor is recorded, not a model; these tests make no quality claims.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import unirig_adapter as adapter


# ── THE FIXTURES, BUILT HERE AND NOT READ OFF THE DISK ──────────────────────
#
# ⚠ WHAT THE PREVIOUS FIXTURE PROVED, AND WHY IT WAS THE BUG.
#
# It emitted a JSON chunk and NO BIN CHUNK — accessors like {"type": "MAT4"}
# with no bufferView, no componentType and no bytes anywhere — and
# validate_skinned_glb() called it a rig. That is the defect exactly: the gate
# only ever compared array indices, so this suite could pass on a file that
# binds nothing, while its own test_successful_in_place_replacement wrote that
# file OVER the mesh it was handed.
#
# So the builder now writes the bytes a consumer actually reads: eight cube
# corners, three identity bind matrices, one joint and a unit weight per vertex,
# twelve indexed triangles — the same layout as server/mesh/fixtures.js, so the
# JavaScript and Python gates describe one geometry rather than two.
# `breaks` names ONE thing to spoil, and every adversarial case below spoils
# BYTES rather than an index.
INDICES = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4,
           2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]


def pack_glb(data, blob):
    body = json.dumps(data).encode()
    body += b" " * (-len(body) % 4)
    binary = bytes(blob) + b"\0" * (-len(blob) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 20 + len(body) + 8 + len(binary))
            + struct.pack("<II", len(body), 0x4E4F534A) + body
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def skinned_glb(skinned=True, breaks=None, size=(0.5, 1.8, 0.3)):
    half = [v / 2 for v in size]
    blob = bytearray(520)
    for v in range(8):                                    # 0..96    POSITION
        for k in range(3):
            struct.pack_into("<f", blob, v * 12 + k * 4, (1 if v & (1 << k) else -1) * half[k])
    for j in range(3):                                    # 96..288  three identity MAT4
        for k in range(4):
            struct.pack_into("<f", blob, 96 + j * 64 + k * 20, 1.0)
    for v in range(8):
        struct.pack_into("<B", blob, 288 + v * 4, v % 3)  # 288..320 JOINTS_0
        struct.pack_into("<f", blob, 320 + v * 16, 1.0)   # 320..448 WEIGHTS_0
    for i, v in enumerate(INDICES):                       # 448..520 indices
        struct.pack_into("<H", blob, 448 + i * 2, v)

    # Each of these is a rig the index-only gate accepted and wrote over a mesh.
    if breaks == "zero-weights":                  # every vertex bound to nothing
        for v in range(8):
            struct.pack_into("<f", blob, 320 + v * 16, 0.0)
    if breaks == "low-sum":                       # vertex 0 only half weighted
        struct.pack_into("<f", blob, 320, 0.5)
    if breaks == "one-unweighted":                # a single loose vertex among eight
        struct.pack_into("<f", blob, 320 + 5 * 16, 0.0)
    if breaks == "joint-out-of-range":            # vertex 4 cites a fourth joint
        struct.pack_into("<B", blob, 288 + 4 * 4, 3)

    data = {
        "asset": {"version": "2.0", "generator": "aiplay unirig adapter test"},
        "scene": 0, "scenes": [{"nodes": [0, 1] if skinned else [0]}],
        "nodes": [{"mesh": 0, "name": "body"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 4 if skinned else 1}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3",
                       "min": [-half[0], -half[1], -half[2]], "max": half}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 96},
                        {"buffer": 0, "byteOffset": 96, "byteLength": 192},
                        {"buffer": 0, "byteOffset": 288, "byteLength": 32},
                        {"buffer": 0, "byteOffset": 320, "byteLength": 128},
                        {"buffer": 0, "byteOffset": 448, "byteLength": 72}],
        "buffers": [{"byteLength": len(blob)}],
    }
    index_accessor = {"bufferView": 4, "componentType": 5123, "count": len(INDICES), "type": "SCALAR"}
    if not skinned:
        data["accessors"].append(index_accessor)
        return pack_glb(data, blob)
    data["nodes"] += [{"name": "root", "children": [2]}, {"name": "spine", "children": [3]},
                      {"name": "head"}]
    data["accessors"] += [
        {"bufferView": 1, "componentType": 5126, "count": 3, "type": "MAT4"},
        {"bufferView": 2, "componentType": 5121, "count": 8, "type": "VEC4"},
        {"bufferView": 3, "componentType": 5126, "count": 8, "type": "VEC4"},
        index_accessor,
    ]
    data["meshes"][0]["primitives"][0]["attributes"].update({"JOINTS_0": 2, "WEIGHTS_0": 3})
    data["skins"] = [{"joints": [1, 2, 3], "inverseBindMatrices": 1, "skeleton": 1}]
    data["nodes"][0]["skin"] = 0
    if breaks == "no-weights-attribute":
        del data["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"]
    return pack_glb(data, blob)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="unirig-test-spaces-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo, self.weights = self.root / "repo with spaces", self.root / "weights"
        self.repo.mkdir()
        for stage, rel in adapter.TASKS.items():
            task = self.repo / rel
            task.parent.mkdir(parents=True, exist_ok=True)
            task.write_text("mode: predict\nresume_from_checkpoint: experiments/old/model.ckpt\ntrainer:\n  devices: 1\n  accelerator: gpu\n", encoding="utf-8")
            checkpoint = self.weights / adapter.CHECKPOINTS[stage]
            checkpoint.parent.mkdir(parents=True, exist_ok=True)
            checkpoint.write_bytes(b"fixture-checkpoint-not-a-model")
        self.source = self.root / "original mesh.glb"
        self.source.write_bytes(b"original bytes must survive failure")
        self.output = self.root / "result.glb"
        self.calls = []

    def executor(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        self.assertIsInstance(argv, list)
        self.assertTrue(kwargs["check"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["cwd"], str(self.repo))
        self.assertEqual(kwargs["env"]["HF_HUB_OFFLINE"], "1")
        self.assertEqual(kwargs["env"]["TRANSFORMERS_OFFLINE"], "1")
        args = dict(a[2:].split("=", 1) for a in argv if a.startswith("--") and "=" in a)
        if "src.data.extract" in argv:
            target = Path(args["output_dir"]) / Path(args["input"]).stem / "raw_data.npz"
        else:
            target = Path(args["output"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(skinned_glb() if target.suffix == ".glb" else b"recorded-stage-result")
        return subprocess.CompletedProcess(argv, 0)

    def test_upstream_stage_order_local_checkpoints_and_seed(self):
        result = adapter.run_stages(self.source, self.output, self.repo, self.weights,
                                    python="isolated python.exe", seed=731, executor=self.executor)
        self.assertEqual([s["stage"] for s in result["rigStages"]],
                         ["extract", "skeleton", "extract-skeleton", "skin", "merge"])
        self.assertEqual(len(self.calls), 5)
        self.assertTrue(all(c[0][0] == "isolated python.exe" for c in self.calls))
        self.assertIn("--seed=731", self.calls[1][0])
        self.assertIn("--seed=731", self.calls[3][0])
        self.assertIn("--data_name=raw_data.npz", self.calls[3][0])
        merge = self.calls[4][0]
        self.assertTrue(any(x.endswith("skin.fbx") and x.startswith("--source=") for x in merge))
        self.assertFalse(any("pip" in part or "bash" in part for c in self.calls for part in c[0]))
        self.assertEqual(result["rigValidation"]["joints"], 3)
        self.assertEqual(result["rigValidation"]["vertices"], 8)
        self.assertEqual(self.source.read_bytes(), b"original bytes must survive failure")
        self.assertFalse(list(self.root.glob(".unirig-*")))

    def test_private_yaml_preserves_upstream_and_uses_absolute_local_checkpoint(self):
        original = (self.repo / adapter.TASKS["skin"]).read_text()
        file = adapter.write_task(self.repo, "skin", self.root, self.weights)
        text = file.read_text()
        self.assertIn(json.dumps(str((self.weights / adapter.CHECKPOINTS["skin"]).resolve())), text)
        self.assertIn("default_root_dir:", text)
        self.assertIn("  devices: 1\n", text)
        self.assertEqual((self.repo / adapter.TASKS["skin"]).read_text(), original)

    def test_failed_intermediate_preserves_existing_output_and_input(self):
        self.output.write_bytes(b"previous rig")
        def fail(argv, **kwargs):
            if "run.py" in argv:
                raise subprocess.CalledProcessError(7, argv)
            return self.executor(argv, **kwargs)
        with self.assertRaises(subprocess.CalledProcessError):
            adapter.run_stages(self.source, self.output, self.repo, self.weights, executor=fail)
        self.assertEqual(self.output.read_bytes(), b"previous rig")
        self.assertEqual(self.source.read_bytes(), b"original bytes must survive failure")
        self.assertFalse(list(self.root.glob(".unirig-*")))

    def test_zero_exit_without_artifact_stops_at_first_stage(self):
        with self.assertRaisesRegex(RuntimeError, "extract finished without"):
            adapter.run_stages(self.source, self.source, self.repo, self.weights,
                               executor=lambda *a, **k: subprocess.CompletedProcess(a, 0))
        self.assertEqual(self.source.read_bytes(), b"original bytes must survive failure")

    def test_unskinned_merge_does_not_replace_in_place_input(self):
        def invalid(argv, **kwargs):
            result = self.executor(argv, **kwargs)
            if "src.inference.merge" in argv:
                output = next(x.split("=", 1)[1] for x in argv if x.startswith("--output="))
                Path(output).write_bytes(skinned_glb(False))
            return result
        with self.assertRaisesRegex(RuntimeError, "no structurally usable"):
            adapter.run_stages(self.source, self.source, self.repo, self.weights, executor=invalid)
        self.assertEqual(self.source.read_bytes(), b"original bytes must survive failure")

    def test_degenerate_rig_does_not_replace_the_in_place_input(self):
        """THE WHOLE POINT, at the boundary that does the damage.

        Not the validator called directly — run_stages() with `source is output`,
        which is how server/mesh/runner.js invokes it (`--glb X --out X`). The
        merge stage returns a GLB whose every weight is zero: a container the
        index-only gate called a rig, one os.replace() away from being the
        user's only copy of their mesh.
        """
        def degenerate(argv, **kwargs):
            result = self.executor(argv, **kwargs)
            if "src.inference.merge" in argv:
                output = next(x.split("=", 1)[1] for x in argv if x.startswith("--output="))
                Path(output).write_bytes(skinned_glb(breaks="zero-weights"))
            return result
        with self.assertRaisesRegex(RuntimeError, "weights sum to 0"):
            adapter.run_stages(self.source, self.source, self.repo, self.weights, executor=degenerate)
        self.assertEqual(self.source.read_bytes(), b"original bytes must survive failure")
        self.assertFalse(list(self.root.glob(".unirig-*")))

    def test_successful_in_place_replacement(self):
        adapter.run_stages(self.source, self.source, self.repo, self.weights, executor=self.executor)
        checked = adapter.validate_skinned_glb(self.source)
        self.assertEqual(checked["joints"], 3)
        self.assertEqual((checked["vertices"], checked["primitives"], checked["verifiedSkins"]), (8, 1, 1))

    def test_invalid_glb_and_missing_weight_attribute_are_rejected(self):
        self.output.write_bytes(b"invalid")
        with self.assertRaisesRegex(RuntimeError, "complete GLB"):
            adapter.validate_skinned_glb(self.output)
        self.output.write_bytes(skinned_glb(breaks="no-weights-attribute"))
        with self.assertRaisesRegex(RuntimeError, "JOINTS_0 and WEIGHTS_0 are required"):
            adapter.validate_skinned_glb(self.output)

    def test_upstream_task_change_stops_before_execution(self):
        (self.repo / adapter.TASKS["skeleton"]).write_text("mode: predict\ntrainer:\n  devices: 1\n")
        with self.assertRaisesRegex(RuntimeError, "task contract changed"):
            adapter.run_stages(self.source, self.output, self.repo, self.weights, executor=self.executor)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.output.exists())

    def test_cli_dispatches_rig_probe_to_configured_interpreter(self):
        spec = importlib.util.spec_from_file_location("mesh_cli", Path(__file__).with_name("mesh_cli.py"))
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        completed = subprocess.CompletedProcess([], 0, adapter.MARKER + '{"canRig":false}', "")
        with patch.dict(os.environ, {"AIPLAY_UNIRIG_PYTHON": "separate python.exe"}), patch("subprocess.run", return_value=completed) as run:
            result = cli.rig_probe()
        self.assertFalse(result["canRig"])
        self.assertEqual(run.call_args.args[0][0], "separate python.exe")
        self.assertIn("--probe", run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")



class SkinGateTests(unittest.TestCase):
    """The adversarial half: rigs that pass an index check and bind nothing.

    ⚠ EVERY ONE OF THESE USED TO PASS. validate_skinned_glb() asserted that
    POSITION, JOINTS_0 and WEIGHTS_0 resolved to in-range accessor indices and
    never opened the BIN chunk, and it is the last gate before os.replace()
    writes the rig OVER the user's mesh (server/mesh/runner.js passes
    `--glb X --out X`). A rig that bound nothing destroyed the original and
    reported a joint count while doing it.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="unirig-skin-gate-")
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "rigged.glb"

    def refusal(self, breaks):
        self.file.write_bytes(skinned_glb(breaks=breaks))
        with self.assertRaises(RuntimeError) as caught:
            adapter.validate_skinned_glb(self.file)
        return str(caught.exception)

    def test_a_valid_rig_still_passes(self):
        """The control. A gate that refuses everything is not a gate."""
        self.file.write_bytes(skinned_glb())
        checked = adapter.validate_skinned_glb(self.file)
        self.assertEqual(checked["joints"], 3)
        self.assertEqual(checked["vertices"], 8)
        self.assertEqual(checked["primitives"], 1)
        self.assertEqual(checked["verifiedSkins"], 1)

    def test_every_weight_zero_is_refused_and_named(self):
        why = self.refusal("zero-weights")
        self.assertIn("vertex 0 weights sum to 0", why)
        self.assertIn("no unweighted vertices", why)

    def test_weights_summing_well_below_one_are_refused(self):
        self.assertIn("vertex 0 weights sum to 0.5", self.refusal("low-sum"))

    def test_one_unweighted_vertex_among_eight_is_refused(self):
        """The quiet one: seven vertices ride the rig and the eighth stays behind."""
        why = self.refusal("one-unweighted")
        self.assertIn("vertex 5", why)
        self.assertIn("sum to 0", why)

    def test_joint_index_outside_the_skin_is_refused(self):
        why = self.refusal("joint-out-of-range")
        self.assertIn("vertex 4 references joint 3", why)
        self.assertIn("outside skin.joints (3)", why)

    def test_a_primitive_claiming_a_skin_without_both_attributes_is_refused(self):
        self.assertIn("JOINTS_0 and WEIGHTS_0 are required", self.refusal("no-weights-attribute"))

    def test_a_container_with_no_bin_chunk_cannot_bind_anything(self):
        """The exact shape of the old fixture: indices with no bytes behind them."""
        data = {"asset": {"version": "2.0"}, "nodes": [{"mesh": 0, "skin": 0}, {}],
                "skins": [{"joints": [1], "inverseBindMatrices": 0}],
                "accessors": [{"type": "MAT4", "count": 1}, {}, {}, {}],
                "meshes": [{"primitives": [{"attributes": {"POSITION": 1, "JOINTS_0": 2,
                                                           "WEIGHTS_0": 3}}]}]}
        body = json.dumps(data).encode()
        body += b" " * (-len(body) % 4)
        self.file.write_bytes(struct.pack("<III", 0x46546C67, 2, 20 + len(body))
                              + struct.pack("<II", len(body), 0x4E4F534A) + body)
        with self.assertRaisesRegex(RuntimeError, "no BIN chunk"):
            adapter.validate_skinned_glb(self.file)

    def test_an_unskinned_mesh_is_refused_as_unskinned(self):
        self.file.write_bytes(skinned_glb(skinned=False))
        with self.assertRaisesRegex(RuntimeError, "no structurally usable"):
            adapter.validate_skinned_glb(self.file)

    def test_a_truncated_container_is_not_reported_as_unrigged(self):
        """And it names the byte counts, because "invalid header" reads as
        "UniRig emitted garbage" when the truth is "the run was cut short".
        Also pins that the three header faults stay distinguishable: a bad
        magic and a bad version must not collapse into the same sentence."""
        whole = skinned_glb()
        self.file.write_bytes(whole[:-8])
        with self.assertRaisesRegex(RuntimeError, r"declares %d bytes and the file is %d"
                                    % (len(whole), len(whole) - 8)):
            adapter.validate_skinned_glb(self.file)
        self.file.write_bytes(b"XXXX" + whole[4:])
        with self.assertRaisesRegex(RuntimeError, "first four bytes are not"):
            adapter.validate_skinned_glb(self.file)
        self.file.write_bytes(whole[:4] + struct.pack("<I", 1) + whole[8:])
        with self.assertRaisesRegex(RuntimeError, "container version 1, expected 2"):
            adapter.validate_skinned_glb(self.file)

    def test_normalized_integer_weights_are_decoded_rather_than_read_raw(self):
        """A 5123 weight of 65535 is 1.0, not 65535. Read raw, it refuses a good rig."""
        blob = bytearray(520)
        for v in range(8):
            for k in range(3):
                struct.pack_into("<f", blob, v * 12 + k * 4, float(v))
        for j in range(3):
            for k in range(4):
                struct.pack_into("<f", blob, 96 + j * 64 + k * 20, 1.0)
        for v in range(8):
            struct.pack_into("<B", blob, 288 + v * 4, v % 3)
            struct.pack_into("<H", blob, 320 + v * 8, 65535)
        data = {
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 1]}],
            "nodes": [{"mesh": 0, "skin": 0}, {"children": [2]}, {"children": [3]}, {}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 2,
                                                       "WEIGHTS_0": 3}}]}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3"},
                {"bufferView": 1, "componentType": 5126, "count": 3, "type": "MAT4"},
                {"bufferView": 2, "componentType": 5121, "count": 8, "type": "VEC4"},
                {"bufferView": 3, "componentType": 5123, "count": 8, "type": "VEC4",
                 "normalized": True},
            ],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 96},
                            {"buffer": 0, "byteOffset": 96, "byteLength": 192},
                            {"buffer": 0, "byteOffset": 288, "byteLength": 32},
                            {"buffer": 0, "byteOffset": 320, "byteLength": 64}],
            "buffers": [{"byteLength": len(blob)}],
            "skins": [{"joints": [1, 2, 3], "inverseBindMatrices": 1, "skeleton": 1}],
        }
        self.file.write_bytes(pack_glb(data, blob))
        self.assertEqual(adapter.validate_skinned_glb(self.file)["vertices"], 8)

    def test_interleaved_vertex_attributes_are_decoded_by_bytestride(self):
        """One bufferView, POSITION/JOINTS_0/WEIGHTS_0 32 bytes apart per vertex."""
        stride, blob = 32, bytearray(8 * 32 + 192)
        for v in range(8):
            for k in range(3):
                struct.pack_into("<f", blob, v * stride + k * 4, float(v + k))
            struct.pack_into("<B", blob, v * stride + 12, v % 3)
            struct.pack_into("<f", blob, v * stride + 16, 1.0)
        for j in range(3):
            for k in range(4):
                struct.pack_into("<f", blob, 256 + j * 64 + k * 20, 1.0)
        data = {
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 1]}],
            "nodes": [{"mesh": 0, "skin": 0}, {"children": [2]}, {"children": [3]}, {}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1,
                                                       "WEIGHTS_0": 2}}]}],
            "accessors": [
                {"bufferView": 0, "byteOffset": 0, "componentType": 5126, "count": 8, "type": "VEC3"},
                {"bufferView": 0, "byteOffset": 12, "componentType": 5121, "count": 8, "type": "VEC4"},
                {"bufferView": 0, "byteOffset": 16, "componentType": 5126, "count": 8, "type": "VEC4"},
                {"bufferView": 1, "componentType": 5126, "count": 3, "type": "MAT4"},
            ],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 256, "byteStride": stride},
                            {"buffer": 0, "byteOffset": 256, "byteLength": 192}],
            "buffers": [{"byteLength": len(blob)}],
            "skins": [{"joints": [1, 2, 3], "inverseBindMatrices": 3, "skeleton": 1}],
        }
        self.file.write_bytes(pack_glb(data, blob))
        self.assertEqual(adapter.validate_skinned_glb(self.file)["vertices"], 8)
        # The same interleaved container with one vertex's weight zeroed is refused.
        struct.pack_into("<f", blob, 6 * stride + 16, 0.0)
        self.file.write_bytes(pack_glb(data, blob))
        with self.assertRaisesRegex(RuntimeError, "vertex 6 weights sum to 0"):
            adapter.validate_skinned_glb(self.file)


class CrossLanguageAgreementTests(unittest.TestCase):
    """One writer, two readers.

    server/mesh/fixtures.js is the only GLB WRITER in this tree, and
    server/mesh/glb_skin_test.js reads its output with the JavaScript gate. If
    the Python gate is a port of that rigour it must accept the very same bytes
    — not bytes this file wrote for itself, which is how glb.js and fixtures.js
    once agreed on a capital G in "glTF" and rejected every real GLB between
    them. Skipped, not failed, where node is not on PATH: this suite's stated
    contract is that it needs no dependencies.
    """

    def fixture(self, options):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on PATH; the JavaScript writer cannot be run")
        source = Path(__file__).with_name("fixtures.js").resolve().as_uri()
        script = ("import { glb } from " + json.dumps(source)
                  + "; process.stdout.write(glb(" + json.dumps(options) + "));")
        done = subprocess.run([node, "--input-type=module", "-e", script], capture_output=True)
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", "replace"))
        return done.stdout

    def test_python_accepts_the_glb_the_javascript_fixtures_write(self):
        with tempfile.TemporaryDirectory(prefix="unirig-cross-") as temp:
            file = Path(temp) / "from-javascript.glb"
            file.write_bytes(self.fixture({"skinned": True}))
            checked = adapter.validate_skinned_glb(file)
            self.assertEqual(checked["joints"], 3)
            self.assertEqual(checked["vertices"], 8)

    def test_python_refuses_the_same_writer_unskinned_and_bind_broken(self):
        with tempfile.TemporaryDirectory(prefix="unirig-cross-") as temp:
            file = Path(temp) / "from-javascript.glb"
            file.write_bytes(self.fixture({"skinned": False}))
            with self.assertRaisesRegex(RuntimeError, "no structurally usable"):
                adapter.validate_skinned_glb(file)
            file.write_bytes(self.fixture({"skinned": True, "breaks": "ibm"}))
            with self.assertRaisesRegex(RuntimeError, "inverseBindMatrices"):
                adapter.validate_skinned_glb(file)
            file.write_bytes(self.fixture({"skinned": True, "breaks": "count"}))
            with self.assertRaisesRegex(RuntimeError, "bind matrices"):
                adapter.validate_skinned_glb(file)


class NativeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="unirig-native-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "source"
        # Small source contracts exercise preparation without an upstream checkout.
        self.sources = {
            "src/data/extract.py": 'for file in inputs:\n            file_name = file.removeprefix("./")\n',
            "src/model/unirig_skin.py": "from flash_attn.modules.mha import MHA\n",
            "configs/model/unirig_ar_350m_1024_81920_float32.yaml": "_attn_implementation: flash_attention_2\n",
            "src/model/pointcept/models/PTv3Object.py": '    flash_attn = None\n            assert flash_attn is not None, "Make sure flash_attn is installed."\nflash_attn.flash_attn_varlen_qkvpacked_func(\n',
        }
        for rel, source in self.sources.items():
            file = self.repo / rel
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(source, encoding="utf-8")
        (self.repo / "run.py").write_text("# source fixture\n")
        contract = {rel: hashlib.sha256(source.encode()).hexdigest() for rel, source in self.sources.items()}
        self.patcher = patch.dict(adapter.NATIVE_SOURCE_HASHES, contract, clear=True)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_preparation_is_private_and_preserves_ragged_point_attention(self):
        target = adapter.prepare_native_runtime(self.repo, self.root / "runtime")
        self.assertIn("os.path.basename(file)", (target / "src/data/extract.py").read_text())
        self.assertIn("NativeCrossMHA as MHA", (target / "src/model/unirig_skin.py").read_text())
        point = (target / "src/model/pointcept/models/PTv3Object.py").read_text()
        self.assertIn("native_varlen_qkvpacked(", point)
        self.assertNotIn("flash_attn.flash_attn_varlen_qkvpacked_func(", point)
        self.assertNotIn("enable_flash=False", point)
        self.assertTrue((target / "src/model/aiplay_native_attention.py").is_file())
        for rel, source in self.sources.items():
            self.assertEqual((self.repo / rel).read_text(), source)
        self.assertFalse((self.repo / "src/model/aiplay_native_attention.py").exists())

    def test_unknown_source_is_rejected_before_copy(self):
        (self.repo / "src/model/unirig_skin.py").write_text("# changed upstream\n")
        with self.assertRaisesRegex(RuntimeError, "source contract changed"):
            adapter.prepare_native_runtime(self.repo, self.root / "runtime")
        self.assertFalse((self.root / "runtime").exists())

    def test_backend_requires_explicit_valid_choice(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(adapter.attention_backend(), "flash_attention_2")
        with patch.dict(os.environ, {"AIPLAY_UNIRIG_ATTENTION": "sdpa"}):
            self.assertEqual(adapter.attention_backend(), "sdpa")
        with patch.dict(os.environ, {"AIPLAY_UNIRIG_ATTENTION": "pretend-flash"}):
            with self.assertRaises(ValueError):
                adapter.attention_backend()


if __name__ == "__main__":
    unittest.main(verbosity=2)
