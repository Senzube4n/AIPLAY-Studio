"""CPU-only output-mode regressions with disposable synthetic float audio.

Tests the real import/render/meter/PCM boundary, not a listening judgement.
No model, installed sample pack, plugin or server is needed.
"""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

import engine
import instruments
import rack


class OutputModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sr = 48000
        t = np.arange(4096) / self.sr
        self.signal = np.column_stack([.35 * np.sin(2 * np.pi * 440 * t),
                                       .21 * np.cos(2 * np.pi * 937 * t)]).astype('float32')
        self.source = self.root / 'source.wav'
        sf.write(self.source, self.signal, self.sr, subtype='FLOAT')

    def job(self, mode='transparent', copies=1):
        mixer = {'stereo': True, 'tracks': {'a': {}, 'b': {}}, 'returns': [],
                 'master': {}, 'spq': [[0., .5]]}
        if mode is not None:
            mixer['outputMode'] = mode
        return {'sr': self.sr, 'start_sample': 0, 'n_samples': len(self.signal), 'notes': [],
                'audio': [{'path': str(self.source), 'track_id': tid, 'start_sample': 0,
                           'dur_samples': len(self.signal)} for tid in ('a', 'b')[:copies]],
                'mixer': mixer}

    def render(self, job, name='render.wav'):
        out = self.root / name
        result = engine.render(dict(job, out=str(out)))
        actual, sr = sf.read(out, dtype='float32', always_2d=True)
        self.assertEqual(sr, self.sr)
        self.assertEqual(sf.info(out).subtype, 'FLOAT')
        return actual, result

    def encode(self, data, name='bounce.wav', **options):
        source = self.root / (name + '.float.wav')
        sf.write(source, data, self.sr, subtype='FLOAT')
        out = self.root / name
        result = instruments._cli_encode({'sr': self.sr, 'wav_parts': [str(source)],
                                          'out': str(out), **options})
        return out, result

    def test_empty_transparent_graph_nulls_against_stereo_import(self):
        actual, result = self.render(self.job())
        np.testing.assert_array_equal(actual, self.signal)
        self.assertEqual(result['outputMode'], 'transparent')

    def test_unity_summing_and_master_gain_and_insert_remain_in_the_path(self):
        job = self.job(copies=2)
        job['mixer']['master'] = {'fader': -6, 'inserts': [
            {'type': 'utility', 'params': {'gain_db': 3}, 'enabled': True}]}
        actual, _ = self.render(job)
        expected = self.signal * (2 * 10 ** ((3 - 6) / 20))
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-7)

    def test_absent_and_explicit_legacy_keep_identical_bytes_and_the_old_curve(self):
        absent, r0 = self.render(self.job(None), 'absent.wav')
        explicit, r1 = self.render(self.job('legacySoftClip'), 'explicit.wav')
        np.testing.assert_array_equal(absent, explicit)
        np.testing.assert_array_equal(absent, np.tanh(.7 * self.signal.astype('float64')).astype('float32'))
        self.assertEqual(r0['sha1'], r1['sha1'])
        self.assertEqual(r0['outputMode'], 'legacySoftClip')

    def test_transparent_float_render_and_meters_keep_over_unity_peaks(self):
        job = self.job(copies=2)
        job['mixer']['master']['fader'] = 12
        actual, result = self.render(job)
        self.assertGreater(float(abs(actual).max()), 1)
        self.assertAlmostEqual(result['peak'], float(abs(actual).max()), places=5)
        measured = rack.meters(job, engine.SYNTHS)
        self.assertEqual(measured['outputMode'], 'transparent')
        self.assertGreater(measured['master']['peak_db'], 0)

    def test_explicit_limiter_is_not_bypassed_by_transparent_output(self):
        job = self.job(copies=2)
        job['mixer']['master'] = {'fader': 0, 'inserts': [
            {'type': 'utility', 'params': {'gain_db': 20}},
            {'type': 'limiter', 'params': {'ceiling_db': -1, 'lookahead_ms': 5}}]}
        actual, _ = self.render(job)
        self.assertLessEqual(rack.true_peak_db(actual.T), -.97)
        self.assertGreater(float(abs(actual).max()), .7)

    def test_transparent_stateful_regions_equal_whole_render(self):
        job = self.job()
        job['mixer']['master']['inserts'] = [{'type': 'eq', 'params': {'b2_gain_db': 3}},
                                           {'type': 'delay', 'params': {'mix': .2}}]
        whole, _ = self.render(job, 'whole.wav')
        pieces = []
        for i, (start, stop) in enumerate([(0, 997), (997, 2593), (2593, len(self.signal))]):
            piece, _ = self.render(dict(job, start_sample=start, n_samples=stop - start), f'part{i}.wav')
            pieces.append(piece)
        np.testing.assert_array_equal(whole, np.concatenate(pieces))

    def test_invalid_explicit_modes_fail_before_render_or_export(self):
        for mode in ('clean', '', None, False):
            job = self.job()
            job['mixer']['outputMode'] = mode
            with self.assertRaisesRegex(ValueError, 'outputMode'):
                self.render(job)
            with self.assertRaisesRegex(ValueError, 'outputMode'):
                self.encode(self.signal, outputMode=mode)
        self.assertFalse((self.root / 'render.wav').exists())
        self.assertFalse((self.root / 'bounce.wav').exists())

    def test_explicit_transparent_pcm_refuses_overload_without_output(self):
        hot = self.signal * 8
        with self.assertRaisesRegex(ValueError, r'would clip: sample peak .*Reduce master gain or add a limiter'):
            self.encode(hot, outputMode='transparent')
        self.assertFalse((self.root / 'bounce.wav').exists())

    def test_safe_transparent_pcm_is_unscaled_and_reports_mode(self):
        out, result = self.encode(self.signal, outputMode='transparent')
        actual, _ = sf.read(out, dtype='float64', always_2d=True)
        np.testing.assert_allclose(actual, self.signal, atol=2 ** -23, rtol=0)
        self.assertEqual(result['outputMode'], 'transparent')
        self.assertAlmostEqual(result['peak'], float(abs(self.signal).max()), places=5)

    def test_pcm_guard_is_after_requested_loudness_processing(self):
        out, result = self.encode(self.signal * 8, outputMode='transparent', target_lufs=-20)
        actual, _ = sf.read(out, always_2d=True)
        self.assertIn('loudness', result)
        self.assertLessEqual(float(abs(actual).max()), 1)

    def test_pcm_guard_checks_final_dithered_samples(self):
        with patch('master.apply_dither', return_value=np.ones((2, len(self.signal))) * 1.01):
            with self.assertRaisesRegex(ValueError, 'would clip'):
                self.encode(self.signal, outputMode='transparent', bit_depth=16)
        self.assertFalse((self.root / 'bounce.wav').exists())

    def test_legacy_pcm_behavior_is_unchanged_even_for_overload(self):
        hot = self.signal * 8
        out0, _ = self.encode(hot, 'old.wav')
        out1, _ = self.encode(hot, 'explicit-old.wav', outputMode='legacySoftClip')
        self.assertEqual(out0.read_bytes(), out1.read_bytes())

    def test_catalog_declares_the_same_modes_and_default(self):
        catalog = rack.catalog_json()
        self.assertEqual(catalog['output_modes'], ['legacySoftClip', 'transparent'])
        self.assertEqual(catalog['output_mode_default'], 'legacySoftClip')


if __name__ == '__main__':
    unittest.main()
