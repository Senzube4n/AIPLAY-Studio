import unittest
import numpy as np
from reactive_rms import frame_peaks


class FrameRmsTests(unittest.TestCase):
    def test_frame_positions_not_seconds_or_beat_grid(self):
        levels = np.zeros(36)
        levels[[3, 14, 29]] = [0.7, 1, 0.9]
        samples = np.repeat(levels, 100)[:, None]
        result = frame_peaks(samples, 1200, 12, 36)
        self.assertEqual(result["peaks"], [0, 3, 14, 29])

    def test_stronger_close_peak_wins_and_threshold_is_strict(self):
        levels = np.zeros(24)
        levels[[2, 5, 13, 20]] = [0.8, 1, 0.5, 0.6]
        result = frame_peaks(np.repeat(levels, 10), 120, 12, 24)
        self.assertEqual(result["peaks"], [0, 5, 20])
        self.assertEqual(result["weights"][13], 0)

    def test_stereo_energy_does_not_cancel_opposite_phase_channels(self):
        levels = np.zeros(20)
        levels[[4, 15]] = 1
        mono = np.repeat(levels, 10)
        self.assertEqual(frame_peaks(np.stack([mono, -mono], axis=1), 120, 12, 20)["peaks"], [0, 4, 15])

    def test_silence_and_constant_energy_have_only_initial_anchor(self):
        for samples in (np.zeros(200), np.ones(200)):
            with self.subTest(value=samples[0]):
                self.assertEqual(frame_peaks(samples, 120, 12, 20)["peaks"], [0])

    def test_plateau_uses_its_middle_frame(self):
        levels = np.zeros(20)
        levels[4:7] = 1
        self.assertEqual(frame_peaks(np.repeat(levels, 10), 120, 12, 20)["peaks"], [0, 5])


if __name__ == "__main__":
    unittest.main()
