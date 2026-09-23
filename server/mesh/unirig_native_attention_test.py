"""Native attention mathematics; runs on CPU without downloading model weights."""
import unittest

try:
    import torch
    from unirig_native_attention import NativeCrossMHA, native_varlen_qkvpacked
except ImportError:
    torch = None


@unittest.skipIf(torch is None, "PyTorch is not installed in this test interpreter")
class NativeAttentionTests(unittest.TestCase):
    def test_cross_attention_matches_independent_softmax_reference(self):
        torch.manual_seed(31)
        model = NativeCrossMHA(48, 3, True).eval()
        self.assertEqual(set(model.state_dict()), {"Wq.weight", "Wq.bias", "Wkv.weight", "Wkv.bias", "out_proj.weight", "out_proj.bias"})
        query, context = torch.randn(2, 7, 48), torch.randn(2, 19, 48)
        q = model.Wq(query).reshape(2, 7, 3, 16)
        k, v = model.Wkv(context).reshape(2, 19, 2, 3, 16).unbind(2)
        weights = torch.einsum("bthd,bshd->bhts", q, k / 4).softmax(-1)
        reference = model.out_proj(torch.einsum("bhts,bshd->bthd", weights, v).reshape(2, 7, 48))
        torch.testing.assert_close(model(query, context), reference, atol=1e-6, rtol=1e-5)

    def test_ragged_sequences_do_not_share_keys_or_values(self):
        torch.manual_seed(19)
        qkv = torch.randn(26, 3, 2, 8)
        boundaries = torch.tensor([0, 8, 16, 19, 26], dtype=torch.int32)
        result = native_varlen_qkvpacked(qkv, boundaries, 8, softmax_scale=.2)
        expected = []
        for start, end in zip(boundaries.tolist(), boundaries.tolist()[1:]):
            q, k, v = qkv[start:end].unbind(1)
            attention = torch.einsum("thd,shd->hts", q, k * .2).softmax(-1)
            expected.append(torch.einsum("hts,shd->thd", attention, v))
        torch.testing.assert_close(result, torch.cat(expected), atol=1e-6, rtol=1e-5)
        changed = qkv.clone()
        changed[19:] *= 100
        torch.testing.assert_close(native_varlen_qkvpacked(changed, boundaries, 8)[:19],
                                   native_varlen_qkvpacked(qkv, boundaries, 8)[:19], atol=0, rtol=0)

    def test_unsupported_modes_and_invalid_partitions_refused(self):
        with self.assertRaises(ValueError):
            NativeCrossMHA(48, 3, False)
        qkv = torch.randn(7, 3, 2, 8)
        for boundaries in ([0, 8], [1, 7], [0, 3, 3, 7], [0, 7]):
            with self.assertRaises(ValueError):
                native_varlen_qkvpacked(qkv, torch.tensor(boundaries), 4)
        with self.assertRaises(ValueError):
            native_varlen_qkvpacked(qkv, torch.tensor([0, 3, 7]), 4, dropout_p=.1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
