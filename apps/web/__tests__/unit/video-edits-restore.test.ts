import { describe, expect, it } from "vitest";
import {
	createTimelineState,
	deleteTimelineRanges,
	getTimelineKeepRanges,
	restoreTimelineRanges,
	setTimelineAutoCutLayer,
	setTimelineTrim,
} from "@/lib/video-edits";

describe("restoreTimelineRanges", () => {
	it("round-trips a delete then restore to the same keep ranges", () => {
		const initial = createTimelineState(10);
		const ranges = [{ start: 2, end: 4 }];
		const deleted = deleteTimelineRanges(initial, ranges);
		const restored = restoreTimelineRanges(deleted, ranges);

		expect(getTimelineKeepRanges(restored)).toEqual(
			getTimelineKeepRanges(initial),
		);
	});

	it("keeps the rest of a longer deletion deleted", () => {
		const deleted = deleteTimelineRanges(createTimelineState(10), [
			{ start: 2, end: 6 },
		]);
		const restored = restoreTimelineRanges(deleted, [{ start: 3, end: 4 }]);

		expect(getTimelineKeepRanges(restored)).toEqual([
			{ start: 0, end: 2 },
			{ start: 3, end: 4 },
			{ start: 6, end: 10 },
		]);
		expect(restored.deletedRanges).toEqual([
			{ start: 2, end: 3 },
			{ start: 4, end: 6 },
		]);
	});

	it("removes overlapping pieces from silence and filler auto-cut layers", () => {
		const withSilence = setTimelineAutoCutLayer(
			createTimelineState(10),
			"silence",
			{
				enabled: true,
				ranges: [{ start: 1, end: 3 }],
				removedMs: 2_000,
				gapCount: 1,
			},
		);
		const withBoth = setTimelineAutoCutLayer(withSilence, "fillers", {
			enabled: true,
			ranges: [{ start: 4, end: 6 }],
			removedCount: 2,
			skippedCount: 1,
		});
		const restored = restoreTimelineRanges(withBoth, [{ start: 2, end: 5 }]);

		expect(restored.autoCuts?.silence.ranges).toEqual([{ start: 1, end: 2 }]);
		expect(restored.autoCuts?.fillers.ranges).toEqual([{ start: 5, end: 6 }]);
		expect(restored.autoCuts?.silence.removedMs).toBe(1_000);
		expect(restored.autoCuts?.silence.gapCount).toBe(1);
		expect(restored.autoCuts?.fillers.removedCount).toBe(2);
		expect(restored.autoCuts?.fillers.skippedCount).toBe(1);
		expect(restored.autoCuts?.silence.enabled).toBe(true);
		expect(restored.autoCuts?.fillers.enabled).toBe(true);
	});

	it("widens the trim when a restored range lies outside it", () => {
		const trimmed = setTimelineTrim(createTimelineState(10), 2, 8);
		const restored = restoreTimelineRanges(trimmed, [{ start: 0.5, end: 1.5 }]);

		expect(restored.trimStart).toBe(0.5);
		expect(restored.trimEnd).toBe(8);
		expect(getTimelineKeepRanges(restored)).toEqual([{ start: 0.5, end: 8 }]);
	});

	it("is a no-op when nothing overlaps", () => {
		const deleted = deleteTimelineRanges(createTimelineState(10), [
			{ start: 2, end: 4 },
		]);
		const restored = restoreTimelineRanges(deleted, [{ start: 6, end: 7 }]);

		expect(getTimelineKeepRanges(restored)).toEqual(
			getTimelineKeepRanges(deleted),
		);
	});
});
