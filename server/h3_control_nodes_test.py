"""CPU fixtures only: no real models, engine, network or CUDA context."""
import importlib
import importlib.abc
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent / "comfy_nodes"))
from aiplay_h3_control import nodes
from aiplay_h3_control import pose_jit_pose
from aiplay_h3_control import full_control_patch as full_patch


def verify_source_bytes(manifest, reader):
    """Use the same integrity rule for checkout files and exported Git blobs."""
    for row in manifest["files"]:
        data = reader(row["file"])
        if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise AssertionError("Shipped source integrity mismatch: " + row["file"])
        if b"\r" in data:
            raise AssertionError("Shipped Python source must use canonical LF: " + row["file"])


class Progress:
    def __init__(self, total): self.total, self.count = total, 0
    def update(self, count): self.count += count


class Runtime:
    def __init__(self, interrupt_at=None):
        self.calls, self.releases, self.interrupt_at = 0, 0, interrupt_at
    def get_torch_device(self): return torch.device("cpu")
    def soft_empty_cache(self): self.releases += 1
    def throw_exception_if_processing_interrupted(self):
        self.calls += 1
        if self.calls == self.interrupt_at: raise InterruptedError("fixture stop")


class DepthModel:
    def __init__(self): self.frames, self.devices = [], []
    def infer_image(self, frame, **kwargs):
        self.frames.append((frame.copy(), kwargs))
        return np.tile(np.arange(frame.shape[1], dtype=np.float32), (frame.shape[0], 1))
    def to(self, device): self.devices.append(str(device)); return self


class NativeControlTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime()
        self.stack = __import__("contextlib").ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(nodes, "_runtime", return_value=(self.runtime, types.SimpleNamespace(ProgressBar=Progress))))
        self.stack.enter_context(mock.patch.object(nodes, "model_path", return_value=Path("fixture-model")))

    def test_schema_is_explicit_offline_small_and_torchscript(self):
        depth = nodes.AiplayH3DepthGuide.INPUT_TYPES()["required"]
        pose = nodes.AiplayH3PoseGuide.INPUT_TYPES()["required"]
        self.assertEqual(depth["model_name"][0], [nodes.DEPTH_NAME])
        self.assertEqual(pose["detector_name"][0], [nodes.DETECTOR_NAME])
        self.assertEqual(pose["pose_name"][0], [nodes.POSE_NAME])
        self.assertNotIn("url", depth)
        self.assertNotIn("path", pose)

    def test_depth_sequential_rgb_to_bgr_and_normalized_output(self):
        model = DepthModel()
        images = torch.zeros((2, 64, 96, 3)); images[..., 0] = 1
        with mock.patch.object(nodes, "_depth_model", return_value=model):
            output, = nodes.AiplayH3DepthGuide().execute(images, resolution=64)
        self.assertEqual(tuple(output.shape), (2, 64, 96, 3))
        self.assertEqual(len(model.frames), 2)
        self.assertEqual(model.frames[0][0][0, 0].tolist(), [0, 0, 255])
        self.assertEqual(model.frames[0][1], {"input_size": 518, "max_depth": 1})
        self.assertEqual(float(output.min()), 0)
        self.assertEqual(float(output.max()), 1)
        self.assertTrue(torch.equal(output[..., 0], output[..., 2]))
        self.assertEqual(model.devices, ["cpu"])
        self.assertEqual(self.runtime.releases, 1)

    def test_depth_flat_map_is_finite_and_invalid_map_refused(self):
        self.assertFalse(nodes.normalize_depth(np.ones((3, 4))).any())
        with self.assertRaisesRegex(ValueError, "invalid"):
            nodes.normalize_depth(np.full((3, 4), np.nan))

    def test_interruption_releases_model_before_propagating(self):
        self.runtime.interrupt_at = 2
        model = DepthModel()
        with mock.patch.object(nodes, "_depth_model", return_value=model):
            with self.assertRaises(InterruptedError):
                nodes.AiplayH3DepthGuide().execute(torch.zeros((3, 64, 96, 3)), resolution=64)
        self.assertEqual(len(model.frames), 1)
        self.assertEqual(model.devices, ["cpu"])
        self.assertEqual(self.runtime.releases, 1)

    def test_invalid_batch_and_nonfinite_input_refused(self):
        for image in (torch.zeros(0, 64, 64, 3), torch.zeros(1, 64, 64), torch.zeros(1, 64, 64, 1)):
            with self.assertRaises(ValueError): nodes.canvas(image, 64)
        with self.assertRaisesRegex(ValueError, "non-finite"):
            nodes.rgb_frame(torch.full((2, 2, 3), float("nan")), 2, 2)
        with self.assertRaises(ValueError): nodes.canvas(torch.zeros(1, 3, 3, 3), 20)

    def test_pose_fixed_batch_chunks_and_rgb_to_bgr(self):
        detector, pose = DepthModel(), DepthModel()
        batch_sizes, colors = [], []
        def detect(_model, frame, **kwargs):
            colors.append(frame[0, 0].tolist())
            return np.tile([0, 0, 96, 64], (12, 1))
        def infer(_model, boxes, _frame, **kwargs):
            batch_sizes.append(len(boxes))
            points = np.zeros((len(boxes), 133, 2), dtype=np.float32)
            points[..., 0], points[..., 1] = 20, 30
            return points, np.ones((len(boxes), 133), dtype=np.float32)
        images = torch.zeros((1, 64, 96, 3)); images[..., 0] = 1
        with mock.patch.object(nodes, "_pose_models", return_value=(detector, pose)), \
             mock.patch("aiplay_h3_control.pose_jit_det.inference_detector", side_effect=detect), \
             mock.patch("aiplay_h3_control.pose_jit_pose.inference_pose", side_effect=infer):
            output, = nodes.AiplayH3PoseGuide().execute(images, resolution=64)
        self.assertEqual(batch_sizes, [5, 5, 2])
        self.assertEqual(colors, [[0, 0, 255]])
        self.assertTrue(output.any())
        self.assertEqual(tuple(output.shape), (1, 64, 96, 3))
        self.assertEqual(detector.devices, ["cpu"])
        self.assertEqual(pose.devices, ["cpu"])

    def test_no_detected_pose_refused_instead_of_silent_black_control(self):
        models = (DepthModel(), DepthModel())
        with mock.patch.object(nodes, "_pose_models", return_value=models), \
             mock.patch("aiplay_h3_control.pose_jit_det.inference_detector", return_value=None):
            with self.assertRaisesRegex(ValueError, "no visible person"):
                nodes.AiplayH3PoseGuide().execute(torch.zeros((2, 64, 96, 3)), resolution=64)
        self.assertEqual(self.runtime.releases, 1)
        self.assertTrue(all(model.devices == ["cpu"] for model in models))

    def test_pose_renderer_obeys_scores_and_validates_shape(self):
        points = np.zeros((1, 133, 2), dtype=np.float32)
        points[..., 0], points[..., 1] = 10, 20
        self.assertFalse(nodes.draw_pose(points, np.zeros((1, 133)), 96, 64).any())
        scores = np.zeros((1, 133)); scores[0, 0] = 1
        guide = nodes.draw_pose(points, scores, 96, 64)
        self.assertTrue(guide[20, 10].any())
        self.assertFalse(guide[50, 50].any())
        with self.assertRaises(ValueError): nodes.draw_pose(points[:, :17], scores[:, :17], 96, 64)

    def test_jit_fixed_batch_padding_does_not_run_redundant_batch(self):
        class Model:
            def __init__(self): self.calls = 0
            def parameters(self): return iter([torch.zeros(1)])
            def __call__(self, images):
                self.calls += 1
                return torch.ones(5, 133, 8), torch.ones(5, 133, 8)
        for count, expected_calls in ((5, 1), (7, 2)):
            model = Model()
            result = pose_jit_pose.inference(model, [np.zeros((4, 4, 3), dtype=np.float32) for _ in range(count)])
            self.assertEqual(len(result), count)
            self.assertEqual(model.calls, expected_calls)

    def test_pose_simcc_decode_and_coordinate_scale(self):
        x = np.zeros((1, 133, 12), dtype=np.float32)
        y = np.zeros((1, 133, 14), dtype=np.float32)
        x[..., 6], y[..., 8] = 0.9, 0.7
        points, scores = pose_jit_pose.decode(x, y, 2)
        np.testing.assert_equal(points[0, 0], [3, 4])
        self.assertAlmostEqual(float(scores[0, 0]), 0.7, places=6)


class LookupAndImportTests(unittest.TestCase):
    def test_lookup_only_fixed_modern_or_legacy_paths_and_complete_files(self):
        with tempfile.TemporaryDirectory(prefix="h3 guide fixture ") as directory:
            root = Path(directory)
            control = root / "models/controlnet"
            fake = types.SimpleNamespace(base_path=str(root), get_folder_paths=lambda kind: [str(control)])
            relative = nodes.WEIGHTS[nodes.DEPTH_NAME][0]
            modern = control / "aiplay_preprocessors" / relative / nodes.DEPTH_NAME
            legacy = root / "custom_nodes/comfyui_controlnet_aux/ckpts" / relative / nodes.DEPTH_NAME
            modern.parent.mkdir(parents=True); legacy.parent.mkdir(parents=True)
            modern.write_bytes(b"ab"); legacy.write_bytes(b"abc")
            with mock.patch.dict(sys.modules, {"folder_paths": fake}), \
                 mock.patch.dict(nodes.WEIGHTS, {nodes.DEPTH_NAME: (relative, 3)}):
                self.assertEqual(nodes.model_path(nodes.DEPTH_NAME), legacy)
                modern.write_bytes(b"abc")
                self.assertEqual(nodes.model_path(nodes.DEPTH_NAME), modern)
                with self.assertRaises(ValueError): nodes.model_path("../../other.pth")
                modern.unlink(); legacy.unlink()
                with self.assertRaises(FileNotFoundError): nodes.model_path(nodes.DEPTH_NAME)

    def test_architecture_and_inference_import_without_extra_dependencies(self):
        denied = ("matplotlib", "skimage", "onnxruntime", "huggingface_hub", "torchvision", "requests")
        class Deny(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname.split(".")[0] in denied:
                    raise AssertionError("Unexpected optional dependency: " + fullname)
        before = torch.cuda.is_initialized()
        finder = Deny(); sys.meta_path.insert(0, finder)
        try:
            for name in ("depth_dpt", "pose_jit_det", "pose_jit_pose"):
                importlib.import_module("aiplay_h3_control." + name)
        finally:
            sys.meta_path.remove(finder)
        self.assertEqual(torch.cuda.is_initialized(), before)

    def test_depth_tensor_transform_uses_model_device_and_rgb_normalization(self):
        from aiplay_h3_control.depth_dpt import DepthAnythingV2
        # Exercise the real transform without constructing or loading a model.
        model = DepthAnythingV2.__new__(DepthAnythingV2)
        torch.nn.Module.__init__(model)
        model.register_parameter("fixture", torch.nn.Parameter(torch.zeros(1)))
        bgr = np.zeros((64, 96, 3), dtype=np.uint8); bgr[..., 2] = 255
        tensor, original = model.image2tensor(bgr)
        self.assertEqual(original, (64, 96))
        self.assertEqual(str(tensor.device), "cpu")
        self.assertEqual(tensor.shape[1], 3)
        self.assertEqual(tensor.shape[2] % 14, 0)
        self.assertEqual(tensor.shape[3] % 14, 0)
        self.assertAlmostEqual(float(tensor[0, 0, 0, 0]), (1 - 0.485) / 0.229, places=5)

    def test_depth_checkpoint_uses_restricted_loader_and_strict_shape_match(self):
        from aiplay_h3_control import depth_dpt
        model = mock.Mock()
        model.eval.return_value = model; model.to.return_value = model
        with mock.patch.object(depth_dpt, "DepthAnythingV2", return_value=model), \
             mock.patch.object(torch, "load", return_value={"fixture": 1}) as load:
            self.assertIs(nodes._depth_model(Path("fixture.pth"), torch.device("cpu")), model)
        load.assert_called_once_with("fixture.pth", map_location="cpu", weights_only=True)
        model.load_state_dict.assert_called_once_with({"fixture": 1}, strict=True)

    def test_package_discovery_loads_no_weights(self):
        import aiplay_h3_control
        with mock.patch.object(torch, "load", side_effect=AssertionError("weights at import")), \
             mock.patch.object(torch.jit, "load", side_effect=AssertionError("weights at import")):
            module = importlib.reload(aiplay_h3_control)
        self.assertEqual(set(module.NODE_CLASS_MAPPINGS), {"AiplayH3DepthGuide", "AiplayH3PoseGuide", "AiplayH3FullControlPatchLoader"})

    def test_vendor_sources_are_present_pinned_and_not_downloader_wrappers(self):
        root = Path(nodes.__file__).parent
        manifest = json.loads((root / "SOURCES.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["revision"], "59b1fc411ede8623b2997855b8018f0b3b6cf49f")
        verify_source_bytes(manifest, lambda name: (root / name).read_bytes())
        for row in manifest["files"]:
            data = (root / row["file"]).read_bytes()
            self.assertNotIn(b"custom_hf_download", data)
            self.assertEqual(len(row["upstreamSha256"]), 64)
        self.assertIn("Exact upstream Git blob", manifest["hashScope"]["upstreamSha256"])
        self.assertTrue((root / "LICENSE").is_file())
        self.assertTrue((root / "NOTICE").is_file())

    def test_integrity_rule_detects_crlf_conversion_and_stale_byte_count(self):
        lf = b"fixture = 1\n"
        manifest = {"files": [{"file": "fixture.py", "bytes": len(lf), "sha256": hashlib.sha256(lf).hexdigest()}]}
        verify_source_bytes(manifest, lambda _name: lf)
        with self.assertRaisesRegex(AssertionError, "integrity mismatch"):
            verify_source_bytes(manifest, lambda _name: lf.replace(b"\n", b"\r\n"))
        manifest["files"][0]["bytes"] += 1
        with self.assertRaisesRegex(AssertionError, "integrity mismatch"):
            verify_source_bytes(manifest, lambda _name: lf)

    def test_staged_git_source_bytes_match_the_staged_manifest(self):
        repo = Path(__file__).resolve().parent.parent
        git = shutil.which("git")
        if not git or not (repo / ".git").exists():
            self.skipTest("Source install has no Git index; working-file integrity is still verified")
        env = {**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_OPTIONAL_LOCKS": "0"}
        def git_bytes(*args):
            return subprocess.check_output([git, "-C", str(repo), *args], env=env, stderr=subprocess.PIPE)
        actual_root = Path(git_bytes("rev-parse", "--show-toplevel").decode().strip()).resolve()
        if actual_root != repo:
            self.skipTest("This source install is not the surrounding repository's root")
        prefix = "server/comfy_nodes/aiplay_h3_control/"
        manifest = json.loads(git_bytes("show", ":" + prefix + "SOURCES.json"))
        # Read BOTH sides from the index. Using the working manifest here could
        # conceal an incorrectly staged SOURCES.json during a commit gate.
        verify_source_bytes(manifest, lambda name: git_bytes("show", ":" + prefix + name))


class FullControlLoaderTests(unittest.TestCase):
    shape = full_patch.ControlShape(hidden=4, attention=4, ffn=6, time=3, head=2)

    def state(self):
        result = {}
        for key, (shape, dtype) in full_patch.original_spec(self.shape).items():
            result[key] = torch.arange(int(np.prod(shape)), dtype=torch.float32).reshape(shape).to(torch.float32 if dtype == "F32" else torch.bfloat16)
        for index in range(5):
            for value, part in enumerate(("q", "k", "v"), 1):
                result[f"control_blocks.{index}.attn.to_{part}.weight"].fill_(value)
        return result

    def header(self):
        header, end = {"__metadata__": {"format": "pt"}}, 0
        for key, (shape, dtype) in full_patch.original_spec(self.shape).items():
            size = int(np.prod(shape)) * (4 if dtype == "F32" else 2)
            header[key] = {"shape": list(shape), "dtype": dtype, "data_offsets": [end, end + size]}
            end += size
        raw = json.dumps(header).encode()
        return header, len(raw), end + len(raw) + 8

    def test_official_original_and_native_key_counts_and_qkv_row_order(self):
        self.assertEqual(len(full_patch.original_spec()), 74)
        state = self.state()
        before = {key: value.clone() for key, value in state.items()}
        native = full_patch.convert_original_state(state, {"format": "pt"}, self.shape)
        self.assertEqual(len(native), 64)
        for index in range(5):
            prefix = f"control_blocks.{index}."
            q, k, v = native[prefix + "attn.qkv_proj.weight"].chunk(3, dim=0)
            self.assertTrue(torch.all(q == 1)); self.assertTrue(torch.all(k == 2)); self.assertTrue(torch.all(v == 3))
            original_value, original_gate = state[prefix + "ff.net.0.proj.weight"].chunk(2, dim=0)
            gate, value = native[prefix + "mlp.fc1.weight"].chunk(2, dim=0)
            self.assertTrue(torch.equal(gate, original_gate))
            self.assertTrue(torch.equal(value, original_value))
        self.assertTrue(all(torch.equal(value, before[key]) for key, value in state.items()), "conversion never mutates source tensors")

    def test_conversion_roundtrip_recovers_every_original_tensor(self):
        original = self.state()
        native = full_patch.convert_original_state(original, {"format": "pt"}, self.shape)
        reverse = {}
        for key, tensor in native.items():
            if key.endswith("attn.qkv_proj.weight"):
                for part, value in zip(("q", "k", "v"), tensor.chunk(3, dim=0)):
                    reverse[key.replace("qkv_proj", "to_" + part)] = value
            elif key.endswith("mlp.fc1.weight"):
                gate, value = tensor.chunk(2, dim=0)
                reverse[key.replace("mlp.fc1", "ff.net.0.proj")] = torch.cat((value, gate))
            else:
                for before, after in (("attn.q_norm", "attn.norm_q"), ("attn.k_norm", "attn.norm_k"), ("attn.out_proj", "attn.to_out.0"), ("mlp.fc2", "ff.net.2")):
                    key = key.replace(before, after)
                reverse[key] = tensor
        self.assertEqual(set(reverse), set(original))
        self.assertTrue(all(torch.equal(reverse[key], original[key]) for key in original))

    def test_swiglu_value_gate_swap_matches_publisher_activation(self):
        state = self.state()
        native = full_patch.convert_original_state(state, {"format": "pt"}, self.shape)
        x = torch.tensor([[0.1, -0.2, 0.3, 0.4]])
        value, gate = torch.nn.functional.linear(x, state["control_blocks.0.ff.net.0.proj.weight"].float()).chunk(2, dim=-1)
        native_gate, native_value = torch.nn.functional.linear(x, native["control_blocks.0.mlp.fc1.weight"].float()).chunk(2, dim=-1)
        self.assertTrue(torch.equal(value * torch.nn.functional.silu(gate), torch.nn.functional.silu(native_gate) * native_value))

    def test_unknown_missing_compressed_and_wrong_dtype_states_refused(self):
        for change in ("extra", "missing", "compressed", "dtype"):
            state = self.state()
            if change == "extra": state["surprise.weight"] = torch.zeros(1)
            elif change == "missing": state.pop("control_blocks.4.norm1.weight")
            elif change == "compressed": state["control_blocks.0.adaln_proj.linear.weight"] = torch.zeros(72, 8, dtype=torch.bfloat16)
            else: state["control_proj_in.weight"] = state["control_proj_in.weight"].bfloat16()
            with self.assertRaises(ValueError): full_patch.convert_original_state(state, {"format": "pt"}, self.shape)
        with self.assertRaises(ValueError): full_patch.convert_original_state(self.state(), {"format": "pt", "minimax_h3_fun_controlnet": "adaln_basis"}, self.shape)

    def test_header_contract_refuses_overlap_truncation_unknown_metadata_and_keys(self):
        header, count, size = self.header()
        full_patch.validate_original_header(header, count, size, self.shape, expected_file_bytes=None)
        import copy
        for change in ("overlap", "size", "shape", "metadata", "extra"):
            candidate = copy.deepcopy(header)
            file_size = size
            if change == "overlap": candidate["control_proj_in.weight"]["data_offsets"] = candidate["control_proj_in.bias"]["data_offsets"]
            elif change == "size": file_size -= 1
            elif change == "shape": candidate["control_blocks.3.adaln_proj.linear.weight"]["shape"][1] = 8
            elif change == "metadata": candidate["__metadata__"]["minimax_h3_fun_controlnet"] = "adaln_basis"
            else: candidate["unknown"] = candidate["control_proj_in.bias"]
            with self.assertRaises(ValueError): full_patch.validate_original_header(candidate, count, file_size, self.shape, expected_file_bytes=None)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            full_patch._unique_object([("format", "pt"), ("format", "pt")])

    def test_loader_uses_native_inference_offload_and_strict_assign_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / full_patch.FULL_PATCH_NAME; path.write_bytes(b"fixture")
            stamp = (path.stat().st_size, path.stat().st_mtime_ns)
            model = mock.Mock(); patcher = mock.Mock(); patcher.is_dynamic.return_value = True
            runtime = types.SimpleNamespace(utils=types.SimpleNamespace(load_torch_file=mock.Mock(return_value=({}, {"format": "pt"}))),
                mm=types.SimpleNamespace(unet_offload_device=lambda: torch.device("cpu"), get_torch_device=lambda: torch.device("cpu")),
                Control=mock.Mock(return_value=model), Patcher=mock.Mock(return_value=patcher), operations=mock.Mock(return_value=(torch.bfloat16, "native-ops")), fast_disk=mock.Mock(return_value=True))
            native = {"fixture.weight": torch.zeros(1)}
            folders = types.SimpleNamespace(get_full_path_or_raise=lambda *_args: str(path))
            with mock.patch.dict(sys.modules, {"folder_paths": folders}), \
                 mock.patch.object(full_patch, "read_original_header", return_value=({}, stamp, "fixture-header")), \
                 mock.patch.object(full_patch, "_native_runtime", return_value=runtime), \
                 mock.patch.object(full_patch, "convert_original_state", return_value=native):
                result, = full_patch.AiplayH3FullControlPatchLoader().load_model_patch(full_patch.FULL_PATCH_NAME)
            self.assertIs(result, patcher)
            runtime.utils.load_torch_file.assert_called_once_with(str(path), safe_load=True, device=torch.device("cpu"), return_metadata=True)
            self.assertEqual(runtime.Control.call_args.kwargs["time_embed_dim"], 2688)
            self.assertFalse(runtime.Control.call_args.kwargs["use_adaln_curves"])
            self.assertEqual(runtime.Control.call_args.kwargs["injection_layers"], (0, 10, 20, 30, 40))
            model.requires_grad_.assert_called_once_with(False); model.eval.assert_called_once()
            model.load_state_dict.assert_called_once_with(native, strict=True, assign=True)

    def test_loader_refuses_other_model_names_before_loading(self):
        with mock.patch.dict(sys.modules, {"folder_paths": types.SimpleNamespace()}), \
             mock.patch.object(full_patch, "read_original_header", side_effect=AssertionError("must not read")):
            with self.assertRaises(ValueError): full_patch.AiplayH3FullControlPatchLoader().load_model_patch("compressed.safetensors")

    def test_old_core_schema_refuses_before_file_listing_or_model_loading(self):
        folders = types.SimpleNamespace(get_filename_list=mock.Mock(side_effect=AssertionError("must not list")))
        with mock.patch.dict(sys.modules, {"folder_paths": folders}), \
             mock.patch.object(full_patch, "_native_runtime", side_effect=RuntimeError("native full-width H3 control support missing")):
            with self.assertRaisesRegex(RuntimeError, "native full-width"):
                full_patch.AiplayH3FullControlPatchLoader.INPUT_TYPES()
        folders.get_filename_list.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
