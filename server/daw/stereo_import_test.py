"""Stereo imports retain time/channel identity; mono recording stays compatible."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf
import capture
import engine


class StereoImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sr = 48000
        t = np.arange(self.sr, dtype=np.float64) / self.sr
        self.stereo = np.stack([.2 * np.sin(2 * np.pi * 440 * t),
                                .11 * np.cos(2 * np.pi * 997 * t)], axis=1).astype('float32')
        self.source = self.root / 'source.wav'
        capture.write_wav_f32(self.source, self.stereo, self.sr)

    def import_source(self, source=None, preserve=True):
        decoded = capture.decode({'path': str(source or self.source), 'sr': self.sr,
                                  'out': str(self.root / 'decoded.f32'),
                                  'preserve_stereo': preserve})
        encoded = capture.encode({'raw': decoded['out'], 'sr': self.sr,
                                  'channels': decoded['channels'],
                                  'out': str(self.root / 'import.flac')})
        return decoded, encoded

    def test_import_duration_and_distinct_channels(self):
        decoded, encoded = self.import_source()
        self.assertEqual((decoded['channels'], encoded['channels']), (2, 2))
        self.assertEqual((decoded['n_samples'], encoded['n_samples']), (self.sr, self.sr))
        self.assertEqual(encoded['seconds'], 1)
        actual = engine._read_audio_f64(encoded['out'], self.sr, preserve_stereo=True)
        self.assertEqual(actual.shape, (2, self.sr))
        np.testing.assert_allclose(actual, self.stereo.T, atol=2e-7, rtol=0)

    def test_stereo_placement_and_region_seams(self):
        _, encoded = self.import_source()
        clips = [{'path': encoded['out'], 'start_sample': -100,
                  'offset_samples': 200, 'dur_samples': 42000, 'gain_db': -3}]
        whole = np.zeros((2, self.sr))
        engine.mix_clips(clips, whole, 0, self.sr)
        parts = []
        for start, end in [(0, 997), (997, 9999), (9999, self.sr)]:
            part = np.zeros((2, end - start))
            engine.mix_clips(clips, part, start, self.sr)
            parts.append(part)
        np.testing.assert_array_equal(whole, np.concatenate(parts, axis=1))
        np.testing.assert_allclose(whole[:, :41900],
                                   self.stereo.T[:, 300:42200] * 10 ** (-3 / 20), atol=2e-7)
        self.assertGreater(float(np.max(abs(whole[0] - whole[1]))), .1)

    def test_mono_lane_means_channels_and_cache_modes_stay_separate(self):
        _, encoded = self.import_source()
        stereo = engine._read_audio_f64(encoded['out'], self.sr, preserve_stereo=True)
        mono = engine._read_audio_f64(encoded['out'], self.sr)
        np.testing.assert_array_equal(mono, stereo.mean(axis=0))
        np.testing.assert_array_equal(stereo, engine._read_audio_f64(encoded['out'], self.sr, True))

    def test_actual_stereo_render_and_stem_keep_the_import_image(self):
        import rack
        _, encoded = self.import_source()
        mixer = {'stereo': True, 'tracks': {'import': {}}, 'returns': [],
                 'master': {}, 'spq': [[0., .5]]}
        job = {'sr': self.sr, 'start_sample': 0, 'n_samples': self.sr,
               'notes': [], 'audio': [{'path': encoded['out'], 'track_id': 'import',
                                      'start_sample': 0, 'dur_samples': self.sr}],
               'mixer': mixer, 'out': str(self.root / 'render.wav')}
        result = engine.render(job)
        rendered, _ = sf.read(job['out'], always_2d=True)
        self.assertEqual(result['clips'], 1)
        self.assertGreater(float(np.max(abs(rendered[:, 0] - rendered[:, 1]))), .1)
        stems = rack.render_stems(dict(job, out_dir=str(self.root / 'stems')), engine.SYNTHS)
        self.assertTrue(stems['sums_to_mix'])
        stem, _ = sf.read(self.root / 'stems' / stems['stems'][0]['file'], always_2d=True)
        np.testing.assert_allclose(stem, self.stereo, atol=2e-7, rtol=0)

    def test_mono_capture_default_is_unchanged(self):
        decoded, encoded = self.import_source(preserve=False)
        self.assertEqual((decoded['channels'], encoded['channels']), (1, 1))
        self.assertEqual(encoded['n_samples'], self.sr)
        mono = engine._read_audio_f64(encoded['out'], self.sr)
        stereo = engine._read_audio_f64(encoded['out'], self.sr, True)
        np.testing.assert_array_equal(stereo[0], mono)
        np.testing.assert_array_equal(stereo[1], mono)

    def test_stereo_wav_fallback_without_pyav(self):
        with patch.object(capture, '_have_av', return_value=False):
            decoded, encoded = self.import_source()
            self.assertEqual(encoded['format'], 'wav')
            np.testing.assert_array_equal(engine._read_audio_f64(encoded['out'], self.sr, True),
                                          self.stereo.T)
            self.assertEqual(capture.probe({'path': encoded['out']})['channels'], 2)

    @unittest.skipUnless(capture._have_av(), 'PyAV is required for resampling')
    def test_stereo_resampling_preserves_antiphase_without_silencing(self):
        t = np.arange(44100) / 44100
        left = .2 * np.sin(2 * np.pi * 500 * t)
        other = self.root / 'antiphase.wav'
        capture.write_wav_f32(other, np.stack([left, -left], axis=1), 44100)
        decoded, encoded = self.import_source(other)
        self.assertEqual(decoded['n_samples'], self.sr)
        y = engine._read_audio_f64(encoded['out'], self.sr, True)
        self.assertGreater(float(np.max(abs(y))), .19)
        np.testing.assert_allclose(y[0], -y[1], atol=2e-7)

    def test_rejects_incomplete_and_nonfinite_pcm_frames(self):
        raw = self.root / 'invalid.f32'
        np.array([.1, .2, .3], dtype='<f4').tofile(raw)
        job = {'raw': str(raw), 'out': str(self.root / 'bad.flac'), 'channels': 2}
        with self.assertRaisesRegex(ValueError, 'complete audio frames'):
            capture.encode(job)
        np.array([0, np.nan], dtype='<f4').tofile(raw)
        with self.assertRaisesRegex(ValueError, 'non-finite'):
            capture.encode(job)

    def test_float_stem_headroom_is_preserved_before_the_track_fader(self):
        self.stereo *= 8
        capture.write_wav_f32(self.source, self.stereo, self.sr)
        _, encoded = self.import_source()
        self.assertEqual(encoded['format'], 'wav')
        self.assertGreater(encoded['peak'], 1)
        np.testing.assert_array_equal(engine._read_audio_f64(encoded['out'], self.sr, True),
                                      self.stereo.T)


if __name__ == '__main__':
    unittest.main()
