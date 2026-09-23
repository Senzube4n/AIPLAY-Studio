"""Image-to-3D preparation must not weld limbs before the model sees them."""
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

from mesh_cli import matte


class MatteTests(unittest.TestCase):
    def prepare(self, image):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        source = str(Path(folder.name) / "source.png")
        target = str(Path(folder.name) / "matte.png")
        self.assertTrue(cv2.imwrite(source, image))
        stats, result = matte(source, target)
        return stats, cv2.imread(result, cv2.IMREAD_UNCHANGED)

    def test_nearby_feet_stay_separate(self):
        image = np.zeros((128, 128, 3), dtype=np.uint8)
        image[24:64, 40:88] = 255
        image[64:104, 40:62] = 255
        image[64:104, 66:88] = 255
        stats, result = self.prepare(image)
        # Crop begins at x=16,y=0 (24px padding around the silhouette).
        self.assertTrue(np.all(result[70:100, 46:50, 3] == 0))
        self.assertTrue(np.all(result[70:100, 30:40, 3] == 255))
        self.assertTrue(stats["preservesThresholdGaps"])

    def test_enclosed_arm_opening_is_not_filled(self):
        image = np.zeros((128, 128, 3), dtype=np.uint8)
        image[24:104, 40:88] = 255
        image[38:62, 52:60] = 0
        _, result = self.prepare(image)
        self.assertTrue(np.all(result[38:62, 36:44, 3] == 0))

    def test_existing_alpha_is_preserved_exactly(self):
        image = np.zeros((128, 128, 4), dtype=np.uint8)
        image[24:104, 40:88] = (100, 150, 200, 255)
        image[30:50, 52:58, 3] = 37
        stats, result = self.prepare(image)
        self.assertEqual(stats["source"], "the picture's own alpha")
        np.testing.assert_array_equal(result, image)

    def test_grayscale_input(self):
        image = np.zeros((128, 128), dtype=np.uint8)
        image[24:104, 40:88] = 255
        _, result = self.prepare(image)
        self.assertEqual(result.shape[2], 4)


if __name__ == "__main__":
    unittest.main()
