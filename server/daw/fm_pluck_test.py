"""CPU-only FM pluck contract and acoustic-property tests.

Synthetic signals only: no server, model, sample pack or audio device. Numeric
evidence is about pitch/envelopes/alias energy, not a listening judgement or a
claim that this sounds like a particular commercial recording.
"""
import hashlib
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
from scipy.signal.windows import blackmanharris

import engine
import instruments as I
import synths as SY


SR = 48000
HERE = Path(__file__).resolve().parent


def rms(y):
    return float(np.sqrt(np.mean(np.square(y))))


def centroid(y, sr=SR):
    power = np.abs(np.fft.rfft(y * np.hanning(len(y)))) ** 2
    hz = np.fft.rfftfreq(len(y), 1 / sr)
    return float(np.sum(power * hz) / max(np.sum(power), 1e-30))


def peak_hz(y, sr=SR):
    power = np.abs(np.fft.rfft(y * np.hanning(len(y)), 8 * len(y))) ** 2
    k = int(np.argmax(power[1:]) + 1)
    return k * sr / (8 * len(y))


class FmPluckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name

    def note(self, midi=60, dur=.25, vel=110, params=None, sr=SR, seed=1):
        return I.note_voice('fm_pluck', midi, int(dur * sr), vel, sr, seed,
                            params or {}, instruments_dir=self.root)

    def test_registry_dispatch_and_declared_tail_use_the_existing_seam(self):
        row = I.patch_row('fm_pluck')
        self.assertEqual((row['kind'], row['builtin'], row['family']),
                         ('builtin', 'fm_pluck', 'synth'))
        self.assertIs(I.machine_module('fm_pluck'), SY)
        self.assertIn('fm_pluck', engine.SYNTHS)
        self.assertEqual(row['tail'], engine.TAILS['fm_pluck'])
        y = self.note()
        self.assertEqual(y.shape, (2, int((.25 + row['tail']) * SR)))
        self.assertTrue(np.all(y[:, -1] == 0))
        self.assertGreater(np.max(np.abs(y)), .1)
        self.assertTrue(np.all(y == y.astype('float32').astype('float64')))

    def test_pitch_tracks_the_requested_note_without_octave_or_ratio_shift(self):
        for midi in (48, 60, 72, 84):
            y = self.note(midi, dur=.5, params={'index': 0, 'body': 1,
                          'transient': 0, 'decay': 2000, 'spread': 0})[0]
            hz = peak_hz(y[int(.02 * SR):int(.4 * SR)])
            expected = 440 * 2 ** ((midi - 69) / 12)
            cents = 1200 * math.log2(hz / expected)
            self.assertLess(abs(cents), 3, (midi, hz, cents))

    def test_fm_brightness_and_tone_decay_are_audible_independent_controls(self):
        dark = self.note(params={'index': 0, 'tone_decay': 400, 'spread': 0})[0]
        bright = self.note(params={'index': 6, 'tone_decay': 400, 'spread': 0})[0]
        a, b = int(.003 * SR), int(.03 * SR)
        self.assertGreater(centroid(bright[a:b]), centroid(dark[a:b]) * 1.8)
        fast = self.note(params={'tone_decay': 15, 'index': 6, 'spread': 0})[0]
        slow = self.note(params={'tone_decay': 400, 'index': 6, 'spread': 0})[0]
        a, b = int(.01 * SR), int(.03 * SR)
        self.assertGreater(centroid(slow[a:b]), centroid(fast[a:b]) * 2)

    def test_carrier_body_and_modulator_ratio_produce_different_spectra(self):
        pure = self.note(params={'body': 1, 'transient': 0, 'tone_decay': 400, 'spread': 0})[0]
        fm = self.note(params={'body': 0, 'transient': 1, 'tone_decay': 400, 'spread': 0})[0]
        a, b = int(.003 * SR), int(.035 * SR)
        self.assertGreater(centroid(fm[a:b]), centroid(pure[a:b]) * 2)
        ratio = self.note(params={'ratio': 3, 'body': 0, 'transient': 1,
                                  'tone_decay': 400, 'spread': 0})[0]
        self.assertGreater(rms(ratio[a:b] - fm[a:b]), .03)
        self.assertFalse(np.any(self.note(params={'body': 0, 'transient': 0})))

    def test_amp_decay_attack_and_noteoff_release_control_actual_time(self):
        quick = self.note(dur=1, params={'decay': 60})[0]
        held = self.note(dur=1, params={'decay': 2000})[0]
        a, b = int(.2 * SR), int(.25 * SR)
        self.assertGreater(rms(held[a:b]), rms(quick[a:b]) * 100)
        soft = self.note(params={'attack': 20})[0]
        sharp = self.note(params={'attack': .2})[0]
        self.assertGreater(rms(sharp[:96]), rms(soft[:96]) * 10)
        p = {'index': 0, 'body': 1, 'transient': 0, 'decay': 2000, 'spread': 0}
        short = self.note(dur=.1, params={**p, 'release': 20})[0]
        long = self.note(dur=.1, params={**p, 'release': 250})[0]
        a, b = int(.14 * SR), int(.16 * SR)
        self.assertGreater(rms(long[a:b]), rms(short[a:b]) * 100)
        release = self.note(dur=.1, params={**p, 'release': 80})[0]
        before = rms(release[int(.08 * SR):int(.1 * SR)])
        after = rms(release[int(.18 * SR):int(.20 * SR)])
        self.assertLess(20 * math.log10(after / before), -60)

    def test_velocity_changes_level_and_optionally_brightness(self):
        p = {'index': 6, 'tone_decay': 200, 'velocity_sensitivity': 1, 'spread': 0}
        soft = self.note(vel=24, params=p)[0]
        hard = self.note(vel=127, params=p)[0]
        a, b = int(.003 * SR), int(.03 * SR)
        self.assertGreater(rms(hard), rms(soft) * 1.5)
        self.assertGreater(centroid(hard[a:b]), centroid(soft[a:b]) * 1.5)
        p['velocity_sensitivity'] = 0
        soft = self.note(vel=24, params=p)[0]
        hard = self.note(vel=127, params=p)[0]
        np.testing.assert_allclose(soft / rms(soft), hard / rms(hard), rtol=0, atol=2e-6)

    def test_stereo_spread_keeps_mono_exact_and_does_not_detune(self):
        mono = self.note(params={'spread': 0})
        stereo = self.note(params={'spread': 1, 'tone_decay': 400})
        np.testing.assert_array_equal(mono[0], mono[1])
        self.assertGreater(rms(stereo[0] - stereo[1]), .01)
        # The pure body is central even when the transient spread is full.
        pure = self.note(params={'transient': 0, 'spread': 1})
        np.testing.assert_array_equal(pure[0], pure[1])

    def test_oversampling_suppresses_a_measured_folded_fm_sideband(self):
        # At C8 the 7*f0 sideband lies above Nyquist and a 1x oscillator
        # folds it to sr-7*f0. Compare against that independently sampled
        # naive FM formula, with the SAME pitch-aware index/envelopes.
        midi, ratio = 108, 2
        f0 = 440 * 2 ** ((midi - 69) / 12)
        p = {'ratio': ratio, 'index': 8, 'tone_decay': 400, 'body': 0,
             'transient': 1, 'attack': .2, 'decay': 2000,
             'velocity_sensitivity': 0, 'spread': 0}
        y = self.note(midi, vel=127, params=p)[0]
        n = int(.035 * SR)
        t = np.arange(n) / SR
        index = max(0, (.4 * SR / f0 - 1) / ratio - 1)
        beta = index * np.exp(-t * math.log(1000) / .4)
        amp = np.exp(-t * math.log(1000) / 2)
        naive = .65 * np.sin(2 * np.pi * f0 * t + beta * np.sin(2 * np.pi * ratio * f0 * t)) * amp
        # Exclude the attack; Blackman-Harris suppresses leakage from nearby
        # legitimate harmonics. Integrate a band, not one fortunate FFT bin.
        start = int(.003 * SR)
        window = blackmanharris(n - start)
        hz = np.fft.rfftfreq(16 * len(window), 1 / SR)
        band = np.abs(hz - (SR - 7 * f0)) < 350
        def energy(signal):
            spectrum = np.fft.rfft(signal[start:n] * window, 16 * len(window))
            return float(np.sum(np.abs(spectrum[band]) ** 2))
        reduction_db = 10 * math.log10(energy(y) / energy(naive))
        print(f'  folded FM sideband versus naive 1x: {reduction_db:.1f} dB')
        self.assertLess(reduction_db, -30)

    def test_knob_extremes_and_supported_rates_remain_finite_with_headroom(self):
        spec = SY.declared_params('fm_pluck')
        for sr in (24000, 48000, 96000):
            for midi in (36, 72, 108, 127):
                for extreme in ('min', 'max'):
                    p = {key: value[extreme] for key, value in spec.items()}
                    y = self.note(midi, .05, 127, p, sr)
                    self.assertTrue(np.all(np.isfinite(y)))
                    self.assertLess(np.max(np.abs(y)), .8)
                    self.assertTrue(np.all(y[:, -1] == 0))

    def test_repeated_notes_ignore_seed_order_and_repeat_across_processes(self):
        first = self.note(seed=7)
        self.note(84, .7, 127, {'index': 8})
        np.testing.assert_array_equal(first, self.note(seed=999))
        command = "import hashlib,synths; y=synths.voice('fm_pluck',60,12000,110,48000); print(hashlib.sha256(y.tobytes()).hexdigest())"
        expected = hashlib.sha256(SY.voice('fm_pluck', 60, 12000, 110, SR).tobytes()).hexdigest()
        actual = subprocess.check_output([sys.executable, '-c', command], cwd=HERE, text=True).strip()
        self.assertEqual(actual, expected)

if __name__ == '__main__':
    unittest.main(verbosity=2)
