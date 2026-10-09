import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np
import lib_audio


class SingleKeepRoundingTest(unittest.TestCase):
    def test_single_keep_rounding_stays_inside_kept_samples(self):
        ticks = [i * 1001 for i in range(12)]
        durs = [1001] * len(ticks)
        for first, count, adjustment in [(1, 6, -1), (2, 4, 1), (0, 6, 0)]:
            with self.subTest(adjustment=adjustment):
                ranges = [{"start": ticks[first] / 30000,
                           "end": ticks[first + count] / 30000}]
                timeline = lib_audio.plan_timeline(ranges, ticks, durs, 30000)
                slot = timeline.slots[0]
                self.assertEqual(slot.adjust, adjustment)
                samples = [lib_audio._slot_source(slot, i, 0)
                           for i in range(slot.slot_hi)]
                self.assertEqual(samples[0], slot.src_lo)
                self.assertTrue(all(slot.src_lo <= s < slot.src_hi for s in samples))
                self.assertEqual(samples[-1], slot.src_hi - 1 - max(adjustment, 0))
                # The same mapping used by the encoder must never read removed audio.
                with patch.object(lib_audio, "_read_presentation",
                                  side_effect=lambda _source, lo, hi: np.ones((hi - lo, 2), np.float32)):
                    pcm, rows = lib_audio.assemble_cut(Path("unused"), timeline, 0, slot.slot_hi)
                lib_audio.assert_plan_kept(rows, timeline)
                self.assertEqual(len(pcm), slot.slot_hi)
                self.assertEqual(pcm[0, 0], 1)
                self.assertEqual(pcm[-1, 0], 0 if adjustment else 1)


if __name__ == "__main__":
    unittest.main()
