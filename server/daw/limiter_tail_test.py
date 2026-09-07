"""A partial final control block must not invent gain reduction at export."""
import unittest
import numpy as np
import rack
import master


class LimiterTailTests(unittest.TestCase):
    def setUp(self):
        self.sr = 48000
        self.params = rack.Params(rack.CATALOG['limiter'],
                                  {'ceiling_db': -1.2, 'release_ms': 80, 'lookahead_ms': 5}, self.sr)
        self.context = {'sr': self.sr, 'spq': [[0, .5]], 'dry': {}}

    def test_under_ceiling_constant_keeps_unity_to_last_sample(self):
        n = self.sr + 37
        signal = np.ones((2, n)) * .02
        gain = rack.limiter_gain(signal, self.params, self.context)
        self.assertEqual(len(gain), n)
        np.testing.assert_allclose(gain, 1, atol=1e-14, rtol=0)

    def test_silence_tail_does_not_report_fictitious_limiting(self):
        n = self.sr * 2 + 37
        signal = np.zeros((2, n))
        t = np.arange(self.sr) / self.sr
        signal[:, :self.sr] = .8 * np.sin(2 * np.pi * 440 * t)
        gain = rack.limiter_gain(signal, self.params, self.context)
        self.assertGreater(float(gain.min()), .99)
        self.assertGreater(float(gain[-1]), .99)

    def test_real_peak_limit_remains_safe_and_report_is_finite(self):
        n = self.sr * 3 + 37
        signal = np.zeros((2, n))
        t = np.arange(self.sr * 2) / self.sr
        signal[:, :len(t)] = .8 * np.sin(2 * np.pi * 440 * t)
        output, report = master.loudness_stage(signal, self.sr, -8, ceiling_db=-1.2, max_limit_db=1)
        self.assertLess(report['limiter_work_db'], 1.05)
        self.assertLessEqual(rack.true_peak_db(output), -1.19)


if __name__ == '__main__':
    unittest.main()
