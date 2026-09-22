import { describe, expect, it } from "vitest";
import {
	clampChapters,
	validateChapterStartsInSection,
	validateGeneratedChapters,
} from "@/lib/ai-chapter-validation";

const speechCue = { start: 0, text: "Meaningful short speech." };

describe("AI chapter validation", () => {
	it("preserves the opening chapter for genuinely empty short-speech output", () => {
		expect(validateGeneratedChapters([], 90, [speechCue])).toEqual([
			{ title: "Opening", start: 0 },
		]);
	});

	it("rejects a candidate at the exclusive end of a transcript section", () => {
		expect(() =>
			validateChapterStartsInSection(
				[{ title: "After the section", start: 30 }],
				{ startTime: 0, endTime: 30 },
				60,
			),
		).toThrow("outside its transcript section");
	});

	it("rejects a candidate at the final video duration boundary", () => {
		expect(() =>
			validateChapterStartsInSection(
				[{ title: "After the video", start: 120 }],
				{ startTime: 0, endTime: 120 },
				120,
			),
		).toThrow("outside the video duration");
	});

	it("rejects generated chapters with equal starts", () => {
		expect(() =>
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Duplicate opening", start: 0 },
				],
				120,
				[
					{ start: 0, text: "Opening remarks." },
					{ start: 60, text: "The main topic." },
				],
			),
		).toThrow("strictly increasing");
	});

	it("uses the existing minimum-gap clamp deterministically for near duplicates", () => {
		expect(
			clampChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Near duplicate", start: 0.5 },
					{ title: "Main topic", start: 10 },
				],
				120,
			),
		).toEqual([
			{ title: "Opening", start: 0 },
			{ title: "Main topic", start: 10 },
		]);
	});

	it("applies the same clamp to cue-aligned near duplicates during validation", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Near duplicate", start: 0.5 },
					{ title: "Main topic", start: 10 },
				],
				120,
				[
					{ start: 0, text: "Opening remarks." },
					{ start: 0.5, text: "Still opening remarks." },
					{ start: 10, text: "The main topic." },
				],
			),
		).toEqual([
			{ title: "Opening", start: 0 },
			{ title: "Main topic", start: 10 },
		]);
	});
});
