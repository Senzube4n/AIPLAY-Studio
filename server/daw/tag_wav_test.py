"""WAV delivery retains PCM, existing notes, explicit origin and sample credits."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
import soundfile as sf
import av

spec = importlib.util.spec_from_file_location("tag_audio", Path(__file__).resolve().parents[1] / "tag_audio.py")
tagger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tagger)


class WavTagTests(unittest.TestCase):
    def test_wave_16_and_24_keep_pcm_comments_and_origin_on_retag(self):
        for bits in (16, 24):
            with self.subTest(bits=bits), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / "master.wav"
                t = np.arange(48017) / 48000
                sf.write(path, np.column_stack([.2 * np.sin(2 * np.pi * 997 * t), .1 * np.cos(2 * np.pi * 440 * t)]),
                         48000, subtype=f"PCM_{bits}")
                expected, sr = sf.read(path, dtype="int32", always_2d=True)
                tagger.tag(str(path), {"COMMENT": "Original session note"})
                metadata = {"COMMENT": "Finished master", "AI_DISCLOSURE": "Agent-programmed composition.",
                            "DIGITALSOURCETYPE": "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
                            "GENERATOR": "AIPlay Studio DAW", "ATTRIBUTION": "Example piano — CC BY 3.0",
                            "COPYRIGHT": "Example piano — CC BY 3.0"}
                for _ in range(2):
                    tagger.tag(str(path), metadata)
                    got, got_sr = sf.read(path, dtype="int32", always_2d=True)
                    np.testing.assert_array_equal(got, expected)
                    self.assertEqual(got_sr, sr)
                    self.assertEqual(sf.info(path).subtype, f"PCM_{bits}")
                with av.open(str(path)) as container:
                    tags = {k.upper(): v for k, v in container.metadata.items()}
                self.assertEqual(tags["COPYRIGHT"], metadata["COPYRIGHT"])
                self.assertEqual(tags["COMMENT"].count("Original session note"), 1)
                self.assertEqual(tags["COMMENT"].count("Finished master"), 1)
                for key in ("AI_DISCLOSURE", "DIGITALSOURCETYPE", "GENERATOR", "ATTRIBUTION"):
                    self.assertIn(f"{key}={metadata[key]}", tags["COMMENT"])
                result = tagger.read_tags(str(path))
                self.assertEqual(result["digitalSourceType"], metadata["DIGITALSOURCETYPE"])
                self.assertEqual(result["aiDisclosure"], metadata["AI_DISCLOSURE"])
                self.assertEqual(result["generator"], metadata["GENERATOR"])
                changed = {**metadata, "DIGITALSOURCETYPE": "http://cv.iptc.org/newscodes/digitalsourcetype/composite"}
                tagger.tag(str(path), changed)
                self.assertEqual(tagger.read_tags(str(path))["digitalSourceType"], changed["DIGITALSOURCETYPE"])


if __name__ == "__main__":
    unittest.main()
