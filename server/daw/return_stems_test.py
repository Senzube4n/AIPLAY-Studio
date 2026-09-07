"""Exported track AND send-return files reconstruct the pre-master mix."""
from pathlib import Path
import tempfile
import unittest

import numpy as np
import soundfile as sf
import engine
import rack


class ReturnStemTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sr = 48000
        self.job = {
            'sr': self.sr, 'start_sample': 0, 'n_samples': self.sr * 3,
            'notes': [
                {'inst': 'pluck', 'midi': 60, 'vel': 90, 'start_sample': 0,
                 'dur_samples': 12000, 'gain_db': -6, 'seed': 1, 'track_id': 'a'},
                {'inst': 'pluck', 'midi': 67, 'vel': 75, 'start_sample': 12000,
                 'dur_samples': 18000, 'gain_db': -6, 'seed': 2, 'track_id': 'b'}],
            'mixer': {'stereo': True, 'tracks': {
                'a': {'sends': [{'to': 'hall', 'level': -3}]},
                'b': {'sends': [{'to': 'hall', 'level': -6}]}},
                'returns': [{'id': 'hall', 'inserts': [{'id': 'reverb', 'type': 'reverb',
                    'params': {'mix': 1., 'room_size': .7, 'predelay_ms': 10}}]}],
                'master': {}, 'spq': [[0., .5]]},
            'out_dir': str(self.root), 'prefix': 'reg0_123456789abc_'}

    def test_return_file_makes_the_exported_sum_complete(self):
        _, buses = rack.chain_graph(self.job, engine.SYNTHS, capture=True)
        result = rack.render_stems(self.job, engine.SYNTHS)
        self.assertEqual(len(result['stems']), 2)
        self.assertEqual(len(result['returns']), 1)
        self.assertEqual(result['returns'][0]['return_id'], 'hall')
        self.assertEqual(result['returns'][0]['file'], 'reg0_123456789abc_ret_hall.wav')
        self.assertTrue(result['sums_to_mix'])
        self.assertTrue(result['exported_complete'])
        self.assertLess(result['exported_residual_db'], -130)
        dry = sum(sf.read(self.root / row['file'], dtype='float64', always_2d=True)[0].T
                  for row in result['stems'])
        wet, sr = sf.read(self.root / result['returns'][0]['file'], dtype='float64', always_2d=True)
        self.assertEqual(sr, self.sr)
        self.assertGreater(float(np.max(abs(wet))), .001)
        self.assertGreater(float(np.max(abs(dry - buses['mix']))), .001)
        np.testing.assert_allclose(dry + wet.T, buses['mix'], atol=1e-8, rtol=0)

    def test_track_subset_does_not_claim_to_reconstruct_full_mix(self):
        result = rack.render_stems(dict(self.job, tracks=['a']), engine.SYNTHS)
        self.assertEqual(len(result['stems']), 1)
        self.assertEqual(len(result['returns']), 1)
        self.assertFalse(result['sums_to_mix'])
        self.assertFalse(result['exported_complete'])
        self.assertGreater(result['exported_residual_db'], -40)

    def test_no_return_project_keeps_the_track_contract(self):
        mixer = dict(self.job['mixer'], returns=[])
        result = rack.render_stems(dict(self.job, mixer=mixer), engine.SYNTHS)
        self.assertEqual(len(result['stems']), 2)
        self.assertEqual(result['returns'], [])
        self.assertTrue(result['sums_to_mix'])


if __name__ == '__main__':
    unittest.main()
