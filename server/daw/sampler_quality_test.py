"""Synthetic SFZ playback proofs; no downloaded packs, plugins, model or GPU.

Spectral rejection, pitch/attack position and loop period are measured, while
the pre-feature legacy voice/cache identity remain pinned independently.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tracemalloc
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf
import instruments as I


class SamplerQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sr = 48000
        t = np.arange(96000) / self.sr
        self.signal = np.vstack([.4 * np.sin(2 * np.pi * 2000 * t) + .1 * np.sin(2 * np.pi * 18000 * t),
                                  .3 * np.sin(2 * np.pi * 2000 * t) - .15 * np.sin(2 * np.pi * 18000 * t)]).astype('float32')
        sf.write(self.root / 'sample.wav', self.signal.T, self.sr, subtype='FLOAT')
        self.mapping = self.root / 'sample.sfz'
        self.mapping.write_text('<region> sample=sample.wav pitch_keycenter=60 lokey=0 hikey=127 '
                                'amp_veltrack=0 loop_mode=one_shot\n', encoding='utf-8')
        self.row = {'id': 'fixture', 'kind': 'sfz', 'file': 'sample.sfz', 'tail': .1, 'oneshot': True}
        self.man = {'rev': 2, 'packs': {}, 'patches': {'fixture': self.row}}
        self.patch = patch.object(I, '_manifest', self.man)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        I._sample_cache.clear()

    def voice(self, quality=None, midi=72, dur=4096):
        params = {} if quality is None else {'resample_quality': quality}
        return I.note_voice('fixture', midi, dur, 127, self.sr, 1, params, str(self.root))

    @staticmethod
    def amplitude(y, frequency):
        y = y[2048:8048]
        return 2 * abs(np.sum(y * np.exp(-2j * np.pi * frequency * np.arange(len(y)) / 48000))) / len(y)

    def test_legacy_default_bytes_and_cache_identity_are_preserved(self):
        old = self.voice()
        # Recorded from the pre-feature HEAD renderer, with this exact
        # synthetic source/mapping. No current helper predicts these pins.
        self.assertEqual(hashlib.sha1(old.astype('<f4').tobytes()).hexdigest(), '5455229caffd138bafe42d4d10c385120ee9f78a')
        key = I._cache_key('fixture', 72, 127, 4096, self.sr, 1, {}, str(self.root))
        self.assertEqual(key, '6d75fc4630d75c00d234fbeff5abb47f7e3be495')
        np.testing.assert_array_equal(old, self.voice(0))
        self.assertEqual(key, I._cache_key('fixture', 72, 127, 4096, self.sr, 1,
                                         {'resample_quality': 0}, str(self.root)))
        self.assertNotEqual(key, I._cache_key('fixture', 72, 127, 4096, self.sr, 1,
                                            {'resample_quality': 1}, str(self.root)))

    def test_octave_up_rejects_folded_high_partial_without_dimming_the_passband(self):
        old, new = self.voice(0)[0], self.voice(1)[0]
        old_alias, new_alias = self.amplitude(old, 12000), self.amplitude(new, 12000)
        reduction = 20 * np.log10(max(new_alias, 1e-20) / old_alias)
        passband = 20 * np.log10(self.amplitude(new, 4000) / self.amplitude(old, 4000))
        print(f'\nSFZ octave-up folded12kHz rejection {reduction:.2f} dB;4kHz passband {passband:+.4f} dB')
        self.assertLess(reduction, -55)
        self.assertLess(abs(passband), .05)

    def test_source_rate_conversion_rejects_aliases_before_pitch_playback(self):
        source_sr = 96000
        t = np.arange(source_sr) / source_sr
        x = .4 * np.sin(2 * np.pi * 4000 * t) + .2 * np.sin(2 * np.pi * 36000 * t)
        source = self.root / 'high-rate.wav'
        sf.write(source, x, source_sr, subtype='FLOAT')
        old = I._load_sample(str(source), self.sr)[0]
        new, original_rate = I._load_bandlimited_sample(str(source), self.sr)
        attenuation = 20 * np.log10(max(self.amplitude(new[0], 12000), 1e-20) / self.amplitude(old, 12000))
        self.assertEqual(original_rate, source_sr)
        self.assertEqual(new.shape, (2, self.sr))
        self.assertLess(attenuation, -55)
        print(f'SFZ96kHz-to-48kHz folded12kHz rejection {attenuation:.2f} dB')

    def test_native_rate_untransposed_voice_is_sample_exact_and_stereo_is_preserved(self):
        np.testing.assert_array_equal(self.voice(0, midi=60), self.voice(1, midi=60))
        self.assertFalse(np.array_equal(self.voice(1)[0], self.voice(1)[1]))

    def test_attack_position_and_impulse_energy_remain_bounded(self):
        source = np.zeros((2, 48000))
        source[:, 12000] = [1, .5]
        actual = I._resample_ratio_bandlimited(source, 2, 24000)
        peak = int(np.argmax(abs(actual[0])))
        self.assertEqual(peak, 6000)
        energy = np.sum(actual[0] ** 2)
        self.assertGreater(np.sum(actual[0, peak - 32:peak + 33] ** 2) / energy, .999)
        self.assertAlmostEqual(float(actual[0].sum()), .5, delta=.001)
        impulse = self.root / 'impulse.wav'
        sf.write(impulse, source.T, 44100, subtype='FLOAT')
        converted, _ = I._load_bandlimited_sample(str(impulse), 48000)
        self.assertLessEqual(abs(int(np.argmax(abs(converted[0]))) - 12000 * 48000 / 44100), 1)

    def test_non_octave_pitch_accuracy_uses_a_bounded_rational_approximation(self):
        errors = []
        for semis in np.linspace(-48, 48, 193):
            ratio = 2 ** (semis / 12)
            up, down = I._pitch_resample_factors(ratio)
            self.assertTrue(1 <= up <= 4096 and 1 <= down <= 4096)
            errors.append(abs(1200 * np.log2((down / up) / ratio)))
        self.assertLess(max(errors), .02)
        print(f'Bounded pitch-ratio approximation worst tested error {max(errors):.6f} cents')

    def test_legal_extreme_keycenters_bound_filter_work_memory_and_pitch_error(self):
        from scipy.signal import resample_poly
        # Reach the actual SFZ/read path in both extreme legal directions.
        # Capturing the real SciPy call proves the bound reaches its FIR,
        # rather than merely checking a helper that the renderer could skip.
        errors = []
        for keycenter, midi in ((0, 127), (127, 0)):
            self.mapping.write_text(f'<region> sample=sample.wav pitch_keycenter={keycenter} '
                                    'lokey=0 hikey=127 amp_veltrack=0 loop_mode=one_shot\n')
            ratio = 2 ** ((midi - keycenter) / 12)
            with patch('scipy.signal.resample_poly', wraps=resample_poly) as resampler:
                tracemalloc.start()
                try:
                    start = time.perf_counter()
                    voice = self.voice(1, midi=midi)
                    elapsed = time.perf_counter() - start
                    _, peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
            self.assertEqual(resampler.call_count, 1)
            up, down = resampler.call_args.args[1:3]
            self.assertTrue(1 <= up <= 4096 and 1 <= down <= 4096, (up, down))
            # SciPy's default prototype has 20*max(up,down)+1 taps.
            self.assertLessEqual(20 * max(up, down) + 1, 81921)
            errors.append(abs(1200 * np.log2((down / up) / ratio)))
            self.assertLess(elapsed, 3.0)
            self.assertLess(peak, 16 * 1024 * 1024)
            self.assertEqual(voice.shape, (2, 8896))
            self.assertTrue(np.isfinite(voice).all())
            self.assertTrue(np.any(voice))
            print(f'Extreme SFZ keycenter{keycenter}/MIDI{midi}: factors{up}/{down}, '
                  f'{elapsed * 1000:.2f}ms, traced peak{peak / 1024**2:.2f}MiB')
        self.assertLess(max(errors), .3)
        print(f'Extreme legal transposition pitch error {max(errors):.6f} cents')

    def test_source_rate_loop_points_and_offset_keep_the_original_loop_period(self):
        source_sr = 44100
        t = np.arange(2205) / source_sr
        sf.write(self.root / 'loop.wav', .4 * np.sin(2 * np.pi * 50 * t), source_sr, subtype='FLOAT')
        self.mapping.write_text('<region> sample=loop.wav pitch_keycenter=60 amp_veltrack=0 '
                                'loop_mode=loop_continuous loop_start=441 loop_end=1322 offset=220 ampeg_release=0\n')
        self.row['oneshot'] = False
        out = self.voice(1, midi=60, dur=9600)
        start = round(441 * 48000 / 44100) - round(220 * 48000 / 44100)
        period = round(1323 * 48000 / 44100) - round(441 * 48000 / 44100)
        self.assertEqual(period, 960)
        np.testing.assert_array_equal(out[:, start:start + period], out[:, start + period:start + 2 * period])
        self.assertEqual(out.shape, (2, 14400))
        self.assertTrue(np.all(out[:, -1] == 0))

    def test_cold_cache_warm_cache_and_another_process_are_identical(self):
        first = self.voice(1)
        np.testing.assert_array_equal(first, self.voice(1))
        # A separate interpreter receives only the synthetic temp mapping.
        code = ('import json,sys,hashlib;sys.path.insert(0,sys.argv[1]);import instruments as I;'
                'I._manifest=json.loads(sys.argv[2]);'
                'y=I.note_voice("fixture",72,4096,127,48000,1,{"resample_quality":1},sys.argv[3]);'
                'print(hashlib.sha1(y.astype("<f4").tobytes()).hexdigest())')
        actual = subprocess.check_output([sys.executable, '-B', '-c', code, str(Path(I.__file__).parent),
                                          json.dumps(self.man), str(self.root)], text=True).strip()
        self.assertEqual(actual, hashlib.sha1(first.astype('<f4').tobytes()).hexdigest())

    def test_sample_cache_modes_do_not_collide_and_remain_bounded(self):
        path = str(self.root / 'sample.wav')
        old = I._load_sample(path, self.sr)
        new, _ = I._load_bandlimited_sample(path, self.sr)
        self.assertEqual(len(I._sample_cache), 2)
        self.assertIs(I._load_sample(path, self.sr), old)
        self.assertIs(I._load_bandlimited_sample(path, self.sr)[0], new)
        with patch.object(I, '_SAMPLE_CACHE_MAX', 2):
            for i in range(3):
                I._load_bandlimited_sample(path, self.sr + i + 1)
                self.assertLessEqual(len(I._sample_cache), 2)

    def test_short_note_cost_is_measured_without_sample_pack_or_model(self):
        sample = self.signal.astype('float64')
        times = {}
        # Warm SciPy's import and filter setup before the repeatable CPU sweep.
        I._resample_ratio_bandlimited(sample, 2 ** (7 / 12), 12000)
        for name, fn in [('linear', I._resample_ratio), ('bandlimited', I._resample_ratio_bandlimited)]:
            start = time.perf_counter()
            for _ in range(12):
                y = fn(sample, 2 ** (7 / 12), 12000)
            times[name] = (time.perf_counter() - start) * 1000 / 12
            self.assertEqual(y.shape, (2, 12000))
            self.assertTrue(np.isfinite(y).all())
        print(f'Quarter-second stereo pitch conversion CPU ms/note {times}')
        self.assertLess(times['bandlimited'], 2000)


if __name__ == '__main__':
    unittest.main()
