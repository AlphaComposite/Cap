"""A1 bounds: nice 19, one encode slot, warm bind skips download. Unit-test fixture only."""
from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mezzanine


class SourcePrepareBoundsTest(unittest.TestCase):
    def test_a1_command_is_nice_19_and_single_slot(self) -> None:
        cmd = mezzanine.mezz_command(Path("in.mp4"), Path("out.mp4"), 15360)
        self.assertEqual(cmd[:3], ["nice", "-n", "19"])
        self.assertEqual(cmd[3], "ffmpeg")
        self.assertIsInstance(mezzanine._A1_SLOT, threading.BoundedSemaphore)


if __name__ == "__main__":
    unittest.main()
