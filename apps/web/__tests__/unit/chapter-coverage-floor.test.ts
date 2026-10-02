import { describe, expect, it } from "vitest";
import {
	getMinimumUsefulChapterCount,
	getRequiredChapterSynthesisCount,
	validateGeneratedChapters,
} from "@/lib/ai-chapter-validation";

const twoPhases = [
	{ title: "Onboarding", start: 0 },
	{ title: "Billing changes", start: 90 },
];

const ewDuration = 2286.998;
const ewPhases = [
	{ title: "Opening walkthrough", start: 0.15 },
	{ title: "Middle implementation", start: 1582.466 },
	{ title: "Closing review", start: 1738.593 },
];
const richCues = [
	{ start: 0.15, text: "I start the deployment walkthrough." },
	{ start: 400, text: "I explain the billing migration." },
	{ start: 800, text: "I review the rollback plan." },
	{ start: 1200, text: "I cover the owner acceptance checks." },
	{ start: 1582.466, text: "I switch to the implementation phase." },
	{ start: 1738.593, text: "I close with the remaining risks." },
	{ start: 2000, text: "I list the follow-up tasks." },
];

describe("duration chapter floors", () => {
	it("reconnects lower bounds to the existing duration guidance", () => {
		expect(getMinimumUsefulChapterCount(119, twoPhases)).toBe(0);
		expect(getMinimumUsefulChapterCount(120, twoPhases)).toBe(2);
		expect(getMinimumUsefulChapterCount(599, twoPhases)).toBe(2);
		expect(getMinimumUsefulChapterCount(600, twoPhases)).toBe(4);
		expect(getMinimumUsefulChapterCount(1799, twoPhases)).toBe(4);
		expect(getMinimumUsefulChapterCount(1800, twoPhases)).toBe(6);
	});

	it("does not let three distinct 38-minute phases satisfy the old floor of 2", () => {
		expect(getMinimumUsefulChapterCount(ewDuration, ewPhases, richCues)).toBe(
			6,
		);
		expect(
			getRequiredChapterSynthesisCount(ewDuration, ewPhases, richCues),
		).toBe(6);
	});

	it("keeps a coherent single topic exempt on a long recording", () => {
		expect(
			getMinimumUsefulChapterCount(
				ewDuration,
				[{ title: "Single deployment review", start: 0.15 }],
				richCues,
			),
		).toBe(0);
		expect(
			getMinimumUsefulChapterCount(
				45 * 60,
				Array.from({ length: 6 }, (_, index) => ({
					title:
						index % 2 === 0 ? "Product walkthrough" : " product WALKTHROUGH ",
					start: index * 450,
				})),
			),
		).toBe(0);
	});

	it("does not count titles alone or cues alone as semantic topics", () => {
		expect(
			getMinimumUsefulChapterCount(ewDuration, [
				{ title: "Alpha", start: Number.NaN },
				{ title: "Beta", start: Number.POSITIVE_INFINITY },
			]),
		).toBe(0);
		expect(getRequiredChapterSynthesisCount(ewDuration, [], richCues)).toBe(0);
		expect(
			getMinimumUsefulChapterCount(ewDuration, ewPhases, richCues),
		).not.toBe(richCues.length);
	});

	it("does not delete legitimate topics to meet a guidance maximum", () => {
		const chapters = Array.from({ length: 13 }, (_, index) => ({
			title: `Phase ${index + 1}`,
			start: index * 70,
		}));
		const cues = chapters.map((chapter) => ({
			start: chapter.start,
			text: `Evidence for ${chapter.title}`,
		}));

		expect(validateGeneratedChapters(chapters, ewDuration, cues)).toHaveLength(
			13,
		);
		expect(
			validateGeneratedChapters(
				Array.from({ length: 7 }, (_, index) => ({
					title: `Short phase ${index + 1}`,
					start: index * 40,
				})),
				400,
				Array.from({ length: 7 }, (_, index) => ({
					start: index * 40,
					text: `Short evidence ${index + 1}`,
				})),
			),
		).toHaveLength(7);
	});

	it("rejects equal slices that are not transcript cues", () => {
		expect(() =>
			validateGeneratedChapters(
				[
					{ title: "Slice one", start: 381.166 },
					{ title: "Slice two", start: 762.333 },
					{ title: "Slice three", start: 1143.499 },
				],
				ewDuration,
				richCues,
			),
		).toThrow("transcript");
	});
});
