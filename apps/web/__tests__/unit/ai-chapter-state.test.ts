import { describe, expect, it } from "vitest";
import { hasValidChapterState } from "@/lib/ai-chapter-state";

const videoDuration = 120;

const validChapters = [
	{ title: "Opening", start: 0 },
	{ title: "Main topic", start: 60 },
];

describe("hasValidChapterState", () => {
	it("rejects an automatic completed state with no chapters", () => {
		expect(hasValidChapterState([], videoDuration, false)).toBe(false);
	});

	it("accepts an explicitly manual empty chapter state", () => {
		expect(hasValidChapterState([], videoDuration, true)).toBe(true);
	});

	it("rejects chapters that are not in chronological order", () => {
		expect(
			hasValidChapterState(
				[
					{ title: "Later", start: 60 },
					{ title: "Opening", start: 0 },
				],
				videoDuration,
				false,
			),
		).toBe(false);
	});

	it("rejects generated chapters with equal starts", () => {
		expect(
			hasValidChapterState(
				[
					{ title: "Opening", start: 0 },
					{ title: "Duplicate opening", start: 0 },
				],
				videoDuration,
				false,
			),
		).toBe(false);
	});

	it("rejects a chapter at the video duration", () => {
		expect(
			hasValidChapterState(
				[{ title: "After", start: videoDuration }],
				videoDuration,
				false,
			),
		).toBe(false);
	});

	it("rejects a chapter beyond the video duration", () => {
		expect(
			hasValidChapterState(
				[{ title: "After", start: videoDuration + 1 }],
				videoDuration,
				false,
			),
		).toBe(false);
	});

	it("accepts one coherent automatic chapter for a long recording", () => {
		expect(
			hasValidChapterState(
				[{ title: "Single coherent topic", start: 0 }],
				1972.9,
				false,
			),
		).toBe(true);
	});

	it("accepts a nonempty generated state within the duration", () => {
		expect(hasValidChapterState(validChapters, videoDuration, false)).toBe(
			true,
		);
	});
});
