"""CPU fixtures for the SparseCtrl loader/Apply ownership boundary.

Run the actual node methods with small numpy tensors and a ControlNet API
fixture. Weak references reproduce ComfyUI's model-manager ownership check.
"""
import ast
from contextlib import nullcontext
import gc
import json
import math
from pathlib import Path
from types import SimpleNamespace
import unittest
import weakref

import numpy as np


class Tensor:
    def __init__(self, data):
        self.data = np.asarray(data)
    @property
    def shape(self):
        return self.data.shape
    def __getitem__(self, key):
        return Tensor(self.data[key])
    def __setitem__(self, key, value):
        self.data[key] = value.data if isinstance(value, Tensor) else value
    def movedim(self, source, target):
        return Tensor(np.moveaxis(self.data, source, target))
    def to(self, *_args, **_kwargs):
        return self
    def float(self):
        return self


class Patcher:
    created = 0
    def __init__(self, model):
        type(self).created += 1
        self.model = model


class ControlNetFixture:
    def __init__(self, control_model=None, load_device=None, manual_cast_dtype=None):
        self.control_model = control_model
        self.load_device = load_device
        self.manual_cast_dtype = manual_cast_dtype
        self.previous_controlnet = None
        self.cond_hint_original = None
        self.strength = 1.0
        self.timestep_percent_range = (0, 1)
        self.extra_args = {}
        if control_model is not None:
            self.control_model_wrapped = Patcher(control_model)
    def copy_to(self, other):
        other.cond_hint_original = self.cond_hint_original
        other.strength = self.strength
        other.timestep_percent_range = self.timestep_percent_range
        other.extra_args = self.extra_args.copy()
    def set_cond_hint(self, hint, strength, window):
        self.cond_hint_original, self.strength, self.timestep_percent_range = hint, strength, window
    def set_previous_controlnet(self, previous):
        self.previous_controlnet = previous


class NetFixture:
    def __init__(self, *_args, **_kwargs):
        pass
    def load_state_dict(self, *_args, **_kwargs):
        return [], []
    def eval(self):
        return self


class VaeFixture:
    def encode(self, pictures):
        values = pictures.data.mean(axis=(1, 2, 3))
        return Tensor(np.broadcast_to(values[:, None, None, None], (len(values), 4, 1, 1)).copy())


source = Path(__file__).with_name("comfy_nodes") / "aiplay_sparsectrl.py"
tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
keep = {"AiplaySparseCtrlLoader", "SparseCtrlControl", "AiplaySparseCtrlApply", "_keyframe_image_pairs"}
body = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in keep]
namespace = {
    "json": json, "math": math,
    "torch": SimpleNamespace(no_grad=nullcontext, float32=np.float32, zeros=lambda shape, **_: Tensor(np.zeros(shape, dtype=np.float32))),
    "comfy": SimpleNamespace(controlnet=SimpleNamespace(ControlNet=ControlNetFixture),
        model_management=SimpleNamespace(get_torch_device=lambda: "cpu", unet_dtype=lambda: "fp32", unet_manual_cast=lambda *_: None, unet_offload_device=lambda: "cpu"),
        ops=SimpleNamespace(disable_weight_init=None), latent_formats=SimpleNamespace(SD15=lambda: SimpleNamespace(process_in=lambda value: value))),
    "folder_paths": SimpleNamespace(get_full_path_or_raise=lambda *_: "test.ckpt"),
    "SparseCtrlNet": NetFixture,
    "_load_sparsectrl": lambda _: ({}, {}, SimpleNamespace(shape=(320, 5, 3, 3)), None, {}),
}
exec(compile(ast.Module(body=body, type_ignores=[]), str(source), "exec"), namespace)
Loader, Apply = namespace["AiplaySparseCtrlLoader"], namespace["AiplaySparseCtrlApply"]


class SparseLifecycleTests(unittest.TestCase):
    def setUp(self):
        Patcher.created = 0
        self.payload = Loader().load("test.ckpt")[0]
        self.pictures = Tensor(np.stack([np.ones((8, 8, 3)), np.full((8, 8, 3), 2)]))

    def apply(self, strength=1, keys="[0, 8]", indices="[0, 1]", previous=None):
        positive = [["positive", {"control": previous} if previous else {}]]
        negative = [["negative", {}]]
        return Apply().apply(positive, negative, self.payload, VaeFixture(), self.pictures, keys, 16, strength, 0, 0.5, indices)

    def test_loader_and_multiple_jobs_share_one_patcher(self):
        first, second = self.apply(), self.apply(strength=0.7)
        owner = self.payload["control"].control_model_wrapped
        self.assertEqual(Patcher.created, 1)
        for job in (first, second):
            for branch in job:
                self.assertIs(branch[0][1]["control"].control_model_wrapped, owner)

    def test_job_hints_strength_and_chain_do_not_modify_cached_template(self):
        previous = object()
        first = self.apply(strength=0.6, previous=previous)[0][0][1]["control"]
        second = self.apply(strength=1.2, keys="[4, 12]", indices="[1, 0]")[0][0][1]["control"]
        template = self.payload["control"]
        self.assertIsNone(template.sparse_cond)
        self.assertIsNone(template.cond_hint_original)
        self.assertIsNone(template.previous_controlnet)
        self.assertEqual(template.strength, 1)
        self.assertIs(first.previous_controlnet, previous)
        self.assertIsNone(second.previous_controlnet)
        self.assertEqual((first.strength, second.strength), (0.6, 1.2))
        self.assertIsNot(first.sparse_cond, second.sparse_cond)
        self.assertEqual(first.sparse_cond.data[0, 0, 0, 0], 1)
        self.assertEqual(second.sparse_cond.data[4, 0, 0, 0], 2)
        first.sub_idxs = [8, 9]
        self.assertIsNone(second.sub_idxs)
        self.assertIsNone(template.sub_idxs)

    def test_dropping_job_controls_keeps_model_manager_owner_alive(self):
        jobs = self.apply()
        control = jobs[0][0][1]["control"]
        owner_ref, net_ref = weakref.ref(control.control_model_wrapped), weakref.ref(control.control_model)
        del control, jobs
        gc.collect()
        self.assertIsNotNone(net_ref())
        self.assertIsNotNone(owner_ref())  # no live-model/dead-patcher state
        self.assertIs(owner_ref(), self.payload["control"].control_model_wrapped)

    def test_evicting_loader_cache_releases_owner_and_model_without_cycles(self):
        jobs = self.apply()
        owner_ref = weakref.ref(self.payload["control"].control_model_wrapped)
        net_ref = weakref.ref(self.payload["net"])
        del jobs
        self.payload = None
        gc.collect()
        self.assertIsNone(owner_ref())
        self.assertIsNone(net_ref())


if __name__ == "__main__":
    unittest.main()
