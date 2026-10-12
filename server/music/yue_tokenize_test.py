"""MERT's rotary table is rebuilt after loading, and the reader refuses to run without it.

Found 2026-09-25: transformers 5 builds MERT-v2-FullSong on the meta device and
then swaps every NON-persistent buffer for torch.empty_like. MERT2's rotary
`embed_positions.inv_freq` is one, the weights file never held it, and MERT2's
own _init_weights never refills it, so every real-audio reading used whatever
that memory held (the same 20 s file read four times gave 1, 269, 269 and 277
distinct codes). yue_tokenize.restore_rotary_inv_freq rebuilds it.

No weights and no card. Three parts:
  - the repair on a stand-in rotary module: rebuilt, cache dropped, still
    non-persistent, and every way it can go wrong raising instead of reading;
  - the wiring: mert_features, with transformers replaced by fakes, repairs the
    table before any audio goes through the model, and fails loudly without one;
  - the real thing: MERT2's own RotaryEmbedding (its modeling code from the
    catalogued folder, no weights) built on the meta device, put through
    transformers' own meta-to-device step (emulated, with a printed note, when
    the venv's transformers has renamed that private step, changed its
    arguments or stopped emptying the buffer: none of that may fail the gate on
    a clean tree), poisoned, repaired, and compared bit for bit with a freshly
    constructed module. Skipped, loudly, when the MERT
    folder is not on this machine (AIPLAY_MERT_DIR, AIPLAY_MODELS_DIR or
    AIPLAY_RIG say where).
"""
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ["CUDA_VISIBLE_DEVICES"] = "-1"   # a no-card test, whatever else holds the card

import numpy as np
import torch
from torch import nn

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("yue_tokenize", HERE / "yue_tokenize.py")
yt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(yt)


def expected_table(head_dim, base):
    return 1.0 / (base ** (torch.arange(0, head_dim, 2, dtype=torch.float32) / head_dim))


class StandInRotary(nn.Module):
    """The attributes MERT2's RotaryEmbedding keeps, with its buffer registered the same way."""

    def __init__(self, head_dim=16, base=10000, fill=float("nan"), dtype=torch.float32, device="cpu"):
        super().__init__()
        self.head_dim = head_dim
        self.base = base
        self.register_buffer("inv_freq", torch.full((head_dim // 2,), fill, dtype=dtype, device=device), persistent=False)
        self._sequence_length = 7
        self._cache_device = torch.device("cpu")
        self._cos = torch.ones(3)
        self._sin = torch.ones(3)


class Holder(nn.Module):
    def __init__(self, rotary, config=None):
        super().__init__()
        self.embed_positions = rotary
        self.proj = nn.Linear(4, 4)
        if config is not None:
            self.config = config


def cfg(hidden=64, heads=4, base=10000):
    return SimpleNamespace(hidden_size=hidden, num_attention_heads=heads, rotary_embedding_base=base)


class RepairOnAStandIn(unittest.TestCase):
    def test_a_poisoned_table_is_rebuilt_and_its_cache_dropped(self):
        model = Holder(StandInRotary(), cfg())
        self.assertTrue(torch.isnan(model.embed_positions.inv_freq).all())
        self.assertEqual(yt.restore_rotary_inv_freq(model), ["embed_positions"])
        rot = model.embed_positions
        self.assertTrue(torch.equal(rot.inv_freq, expected_table(16, 10000)))
        self.assertEqual(rot.inv_freq.dtype, torch.float32)
        self.assertIsNone(rot._cos)
        self.assertIsNone(rot._sin)
        self.assertEqual(rot._sequence_length, 0)
        self.assertIsNone(rot._cache_device)

    def test_the_buffer_stays_non_persistent(self):
        model = Holder(StandInRotary(), cfg())
        yt.restore_rotary_inv_freq(model)
        self.assertIn("inv_freq", model.embed_positions._non_persistent_buffers_set)
        self.assertNotIn("embed_positions.inv_freq", model.state_dict())

    def test_the_rebuilt_table_keeps_the_buffers_device_and_dtype(self):
        model = Holder(StandInRotary(dtype=torch.float64), cfg())
        yt.restore_rotary_inv_freq(model)
        got = model.embed_positions.inv_freq
        self.assertEqual(got.dtype, torch.float64)
        self.assertEqual(got.device.type, "cpu")
        self.assertTrue(torch.equal(got, expected_table(16, 10000).to(torch.float64)))

    def test_every_rotary_buffer_is_rebuilt(self):
        model = Holder(StandInRotary(), cfg())
        model.second = StandInRotary(head_dim=16, base=10000, fill=1e30)
        self.assertEqual(sorted(yt.restore_rotary_inv_freq(model)), ["embed_positions", "second"])
        self.assertTrue(torch.equal(model.second.inv_freq, expected_table(16, 10000)))

    def test_no_rotary_buffer_at_all_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "without a rotary inv_freq buffer"):
            yt.restore_rotary_inv_freq(nn.Sequential(nn.Linear(2, 2)))

    def test_a_buffer_without_head_dim_and_base_is_refused(self):
        rot = StandInRotary()
        del rot.head_dim
        with self.assertRaisesRegex(RuntimeError, "will not guess"):
            yt.restore_rotary_inv_freq(Holder(rot))

    def test_a_disagreement_with_the_config_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "the config says 16 and 500000"):
            yt.restore_rotary_inv_freq(Holder(StandInRotary(), cfg(base=500000)))

    def test_a_non_finite_table_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "non-finite"):
            yt.restore_rotary_inv_freq(Holder(StandInRotary(base=0)))   # 1 / 0**x: inf

    def test_a_buffer_never_materialised_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "never materialised"):
            yt.restore_rotary_inv_freq(Holder(StandInRotary(device="meta"), cfg()))

    def test_any_other_non_persistent_buffer_is_refused_before_anything_is_touched(self):
        # transformers 5 empties every non-persistent buffer; only the rotary table is rebuilt here
        model = Holder(StandInRotary(), cfg())
        model.proj.register_buffer("window", torch.ones(4), persistent=False)
        with self.assertRaisesRegex(RuntimeError, r"does not rebuild \(proj\.window\)"):
            yt.restore_rotary_inv_freq(model)
        self.assertTrue(torch.isnan(model.embed_positions.inv_freq).all(), "nothing is half repaired")

    def test_a_persistent_buffer_is_left_to_the_weights(self):
        model = Holder(StandInRotary(), cfg())
        model.proj.register_buffer("window", torch.ones(4))   # persistent: the checkpoint fills it
        self.assertEqual(yt.restore_rotary_inv_freq(model), ["embed_positions"])


class FakeMert(nn.Module):
    """What AutoModel.from_pretrained hands back, reduced to what mert_features touches."""

    def __init__(self, rotary=True):
        super().__init__()
        self.config = cfg(hidden=64, heads=4, base=10000)
        if rotary:
            self.embed_positions = StandInRotary()
        self.layer = nn.Linear(1, 1)
        self.tables_seen = []

    def forward(self, input_values, output_hidden_states=True):
        rot = getattr(self, "embed_positions", None)
        self.tables_seen.append(None if rot is None else rot.inv_freq.clone())
        frames = input_values.shape[1] // 960
        states = tuple(torch.full((input_values.shape[0], frames, 1024), float(i)) for i in range(25))
        return SimpleNamespace(hidden_states=states)


def fake_transformers(model):
    mod = types.ModuleType("transformers")
    mod.AutoModel = SimpleNamespace(from_pretrained=lambda *a, **k: model)
    mod.AutoFeatureExtractor = SimpleNamespace(from_pretrained=lambda *a, **k: (
        lambda group, sampling_rate, return_tensors: {"input_values": torch.tensor(np.stack(group))}))
    return mod


class TheWiring(unittest.TestCase):
    def run_features(self, model):
        saved = sys.modules.get("transformers")
        sys.modules["transformers"] = fake_transformers(model)
        try:
            return yt.mert_features(np.zeros(2 * yt.MERT_SR, dtype=np.float32), "unused", torch.device("cpu"))
        finally:
            if saved is not None:
                sys.modules["transformers"] = saved
            else:
                sys.modules.pop("transformers", None)

    def test_the_table_is_rebuilt_before_any_audio_goes_through(self):
        model = FakeMert()
        feats = self.run_features(model)
        self.assertEqual(feats.shape, (50, 1024))
        self.assertEqual(len(model.tables_seen), 1)
        self.assertTrue(torch.equal(model.tables_seen[0], expected_table(16, 10000)))

    def test_a_model_with_no_rotary_table_stops_the_reading(self):
        model = FakeMert(rotary=False)
        with self.assertRaisesRegex(RuntimeError, "without a rotary inv_freq buffer"):
            self.run_features(model)
        self.assertEqual(model.tables_seen, [], "no audio may go through an unchecked model")

    def test_the_reader_version_is_declared(self):
        self.assertIsInstance(yt.MERT_READER, int)
        self.assertGreaterEqual(yt.MERT_READER, 2)


def mert_dir():
    for d in (os.environ.get("AIPLAY_MERT_DIR"),
              os.environ.get("AIPLAY_MODELS_DIR") and os.path.join(os.environ["AIPLAY_MODELS_DIR"], "audio_encoders", "MERT-v2-FullSong"),
              os.environ.get("AIPLAY_RIG") and os.path.join(os.environ["AIPLAY_RIG"], "ComfyUI", "models", "audio_encoders", "MERT-v2-FullSong")):
        if d and all(os.path.isfile(os.path.join(d, f)) for f in ("config.json", "configuration_mert2.py", "modeling_mert2.py")):
            return d
    return None


class TheRealRotaryEmbedding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = mert_dir()
        if not cls.dir:
            print("\n  SKIP  MERT2's own RotaryEmbedding: no MERT-v2-FullSong folder with its modeling code here "
                  "(set AIPLAY_MERT_DIR, AIPLAY_MODELS_DIR or AIPLAY_RIG). The stand-in sections still ran.", flush=True)
            raise unittest.SkipTest("no MERT modeling code on this machine")
        from transformers import AutoConfig, AutoModel
        cls.config = AutoConfig.from_pretrained(cls.dir, trust_remote_code=True)
        with torch.device("meta"):   # how from_pretrained builds it under transformers 5 (get_init_context)
            cls.model = AutoModel.from_config(cls.config, trust_remote_code=True)

    def test_the_real_module_is_repaired_to_what_its_constructor_builds(self):
        model, config = self.model, self.config
        rot = model.embed_positions
        self.assertEqual(type(rot).__name__, "RotaryEmbedding")
        self.assertIn("inv_freq", rot._non_persistent_buffers_set)
        built = rot.inv_freq
        # transformers' own step, when this venv's transformers still has it as
        # read on 2026-09-25 (5.15): every non-persistent buffer becomes empty
        # memory. It is a private method, and a transformers that renames it,
        # changes its arguments or stops replacing the buffer changes nothing in
        # this repo, so none of those may fail the gate on a clean tree: the
        # damage is emulated instead, loudly, and the repair is checked all the
        # same (it is harmless where the table was already right).
        mover = getattr(model, "_move_missing_keys_from_meta_to_device", None)
        why = "this transformers has no _move_missing_keys_from_meta_to_device"
        if mover is not None:
            try:
                mover(set(), None, None, None)
                why = None if model.embed_positions.inv_freq is not built else \
                    "this transformers no longer replaces the buffer (re-check the finding; the repair stays harmless)"
            except TypeError as e:
                why = "this transformers' _move_missing_keys_from_meta_to_device takes other arguments (%s)" % e
        if why:
            print("\n  note  %s; the empty buffer is emulated" % why, flush=True)
            model.embed_positions.inv_freq = torch.empty_like(built)
        # Uninitialised memory can hold anything, the right numbers included; make the damage certain.
        model.embed_positions.inv_freq.fill_(float("nan"))
        self.assertEqual(yt.restore_rotary_inv_freq(model), ["embed_positions"])
        fresh = type(rot)(config)   # a freshly constructed module, outside any meta context
        got = model.embed_positions.inv_freq
        self.assertTrue(torch.equal(got, fresh.inv_freq), "the repaired table differs from the constructor's")
        self.assertEqual(got.dtype, torch.float32)
        self.assertEqual(list(got.shape), [config.hidden_size // config.num_attention_heads // 2])
        self.assertIn("inv_freq", model.embed_positions._non_persistent_buffers_set)
        self.assertIsNone(model.embed_positions._cos)


if __name__ == "__main__":
    unittest.main(verbosity=2)
