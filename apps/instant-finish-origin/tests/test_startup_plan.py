"""Startup segmentation changes only boundaries, never kept samples or PTS."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin
import lib_audio

class StartupPlanTests(unittest.TestCase):
    def test_half_second_prefix_retains_full_timeline_and_audio_grid(self):
        for tb, step in [(15360, 512), (16000, 533)]:
            durs = [step + (40 if i % 5 == 0 else 0) for i in range(240)]
            ticks, cursor = [], 0
            for dur in durs:
                ticks.append(cursor)
                cursor += dur
            ranges = [{'start': 0, 'end': 4.0}, {'start': 5.0, 'end': 7.0}]
            for keyframes in [None, [{'index': i, 'pts': ticks[i]} for i in range(0, len(ticks), 30)]]:
                plan = lib_origin.plan_segments(ranges, ticks, durs, tb, keyframes)
                self.assertGreaterEqual(plan[0].duration_ticks, tb // 2)
                self.assertLess(plan[0].duration_ticks, tb // 2 + max(durs))
                frames = [f for s in plan for f in s.frames]
                expected = [i for ids in lib_origin.kept_frame_ids(ticks, ranges, tb) for i in ids]
                self.assertEqual([f.index for f in frames], expected)
                self.assertEqual([f.src_pts for f in frames], [ticks[i] for i in expected])
                self.assertEqual(lib_origin.duration_ticks(plan), sum(durs[i] for i in expected))
                self.assertEqual([f.out_pts for f in frames], [sum(durs[i] for i in expected[:j]) for j in range(len(expected))])
                timeline = lib_audio.plan_timeline(ranges, ticks, durs, tb)
                grid = lib_audio.assign_grid(plan, timeline)
                for segment, (j0, j1) in zip(plan, grid):
                    start, durations = lib_audio.align_audio_timing(j1 - j0 + (1 if segment.index == 0 else 0), leading=segment.index == 0, video_start_ticks=segment.out_pts, video_duration_ticks=segment.duration_ticks, video_tb=tb)
                    self.assertEqual(start, lib_audio.presentation_samples(segment.out_pts, tb))
                    self.assertEqual(sum(durations), lib_audio.presentation_samples(segment.out_pts + segment.duration_ticks, tb) - start)
                text = lib_origin.playlist_text(plan, tb)
                self.assertNotIn('DISCONTINUITY', text)
                self.assertIn('#EXT-X-ENDLIST', text)

    def test_long_first_hold_is_not_split_or_dropped(self):
        plan = lib_origin.plan_segments([{'start': 0, 'end': 2}], [0, 900, 1000, 1500], [900, 100, 500, 500], 1000, [{'index': 0, 'pts': 0}])
        self.assertEqual(plan[0].frames[0].dur, 900)
        self.assertEqual(lib_origin.duration_ticks(plan), 2000)

if __name__ == '__main__':
    unittest.main()
