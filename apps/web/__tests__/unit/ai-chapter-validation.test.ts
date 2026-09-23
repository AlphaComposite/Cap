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

	it("collapses generated chapters with exact duplicate starts", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Duplicate opening", start: 0 },
					{ title: "Main topic", start: 60 },
				],
				120,
				[
					{ start: 0, text: "Opening remarks." },
					{ start: 60, text: "The main topic." },
				],
			),
		).toEqual([
			{ title: "Opening", start: 0 },
			{ title: "Main topic", start: 60 },
		]);
	});

	it("sorts valid generated chapters before timestamp validation", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Second", start: 60 },
					{ title: "Opening", start: 0 },
				],
				120,
				[
					{ start: 0, text: "Opening cue" },
					{ start: 60, text: "Second cue" },
				],
			),
		).toEqual([
			{ title: "Opening", start: 0 },
			{ title: "Second", start: 60 },
		]);
	});

	it("aligns an approximate opening to the first delayed speech cue", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 3.18 },
					{ title: "Main topic", start: 60 },
				],
				120,
				[
					{ start: 15, text: "Opening cue" },
					{ start: 60, text: "Main topic cue" },
				],
			),
		).toEqual([
			{ title: "Opening", start: 15 },
			{ title: "Main topic", start: 60 },
		]);
	});

	it("collapses opening candidates that converge on the delayed cue", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Alternate opening", start: 3.18 },
					{ title: "Main topic", start: 90 },
				],
				180,
				[
					{ start: 27, text: "First spoken words." },
					{ start: 90, text: "Main topic cue." },
				],
			),
		).toEqual([
			{ title: "Alternate opening", start: 27 },
			{ title: "Main topic", start: 90 },
		]);
	});

	it("rejects unsorted provider starts during section validation", () => {
		expect(() =>
			validateChapterStartsInSection(
				[
					{ title: "Later", start: 90 },
					{ title: "Earlier", start: 27 },
				],
				{ startTime: 0, endTime: 120 },
				180,
				[
					{ start: 27, text: "Opening cue." },
					{ start: 90, text: "Later cue." },
				],
			),
		).toThrow("unsorted chapter timestamps");
	});

	it("does not fabricate alignment across more than 30 seconds of silence", () => {
		expect(() =>
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Main topic", start: 90 },
				],
				180,
				[
					{ start: 31, text: "First spoken words." },
					{ start: 90, text: "Main topic cue." },
				],
			),
		).toThrow();
	});

	it("preserves later cue-aligned chapters after opening normalization", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "Alternate opening", start: 3.18 },
					{ title: "First topic", start: 50 },
					{ title: "Main topic", start: 100 },
				],
				180,
				[
					{ start: 27, text: "First spoken words." },
					{ start: 50, text: "First topic cue." },
					{ start: 100, text: "Main topic cue." },
				],
			),
		).toEqual([
			{ title: "Alternate opening", start: 27 },
			{ title: "First topic", start: 50 },
			{ title: "Main topic", start: 100 },
		]);
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
