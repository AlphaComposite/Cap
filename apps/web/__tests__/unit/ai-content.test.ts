import { describe, expect, it } from "vitest";
import {
	formatChapterTime,
	MAX_CHAPTERS,
	parseChapterTime,
	validateAiContent,
} from "@/lib/ai-content";

const content = (starts: number[]) => ({
	summary: "A summary",
	chapters: starts.map((start) => ({ title: "Topic", start })),
});

describe("chapter timestamps", () => {
	it.each([
		["00:00", 0],
		["02:30", 150],
		["90:10", 5410],
		["1:30:10.125", 5410.125],
		[" 00:01.5 ", 1.5],
	])("parses %s", (text, seconds) => {
		expect(parseChapterTime(text)).toBe(seconds);
	});
	it.each([
		"",
		"12",
		"1:60",
		"1:99:00",
		"-1:00",
		"1:2",
		"1:00garbage",
		"NaN",
		"Infinity",
	])("rejects %s", (value) => {
		expect(parseChapterTime(value)).toBeNaN();
	});
	it.each([0, 1.123, 59.999, 60, 3599, 3600, 5410.125, 86400])(
		"round-trips %s seconds",
		(seconds) => {
			expect(parseChapterTime(formatChapterTime(seconds))).toBe(seconds);
		},
	);
});

describe("AI content validation", () => {
	it("allows removing all summary and chapters", () => {
		expect(validateAiContent({ summary: "", chapters: [] }, 10)).toBeNull();
	});
	it("allows strictly ordered chapters within duration", () => {
		expect(validateAiContent(content([0, 10.125, 40]), 60)).toBeNull();
	});
	it("accepts an owner chapter of exactly 10 seconds", () => {
		expect(validateAiContent(content([0, 10, 20]), 30)).toBeNull();
		expect(validateAiContent(content([0, 10]), 20)).toBeNull();
	});
	it("accepts a single chapter shorter than 10 seconds", () => {
		expect(validateAiContent(content([0]), 7)).toBeNull();
		expect(validateAiContent(content([2]), 6)).toBeNull();
	});
	it("rejects an owner chapter shorter than 10 seconds", () => {
		expect(validateAiContent(content([0, 30, 35]), 100)).toBe(
			"Chapter 2 must be at least 10 seconds long.",
		);
		expect(validateAiContent(content([0, 9.999]), 30)).toBe(
			"Chapter 1 must be at least 10 seconds long.",
		);
		expect(validateAiContent(content([0, 95]), 100)).toBe(
			"Chapter 2 must be at least 10 seconds long.",
		);
	});
	it("keeps earlier chapter errors ahead of the length rule", () => {
		expect(validateAiContent(content([5, 1]), 60)).toContain(
			"increasing order",
		);
		expect(
			validateAiContent(
				{
					summary: "",
					chapters: [
						{ title: "  ", start: 0 },
						{ title: "Later", start: 1 },
					],
				},
				60,
			),
		).toContain("needs a title");
	});
	it.each([
		[0, 0],
		[10, 5],
	])("rejects duplicate or unordered times %j", (...starts) => {
		expect(validateAiContent(content(starts), 60)).toContain(
			"increasing order",
		);
	});
	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"rejects invalid time %s",
		(start) => {
			expect(validateAiContent(content([start]))).toContain("valid timestamp");
		},
	);
	it("rejects timestamps at or beyond the end", () => {
		expect(validateAiContent(content([60]), 60)).toContain(
			"before the video ends",
		);
	});
	it("supports recordings with unknown duration", () => {
		expect(validateAiContent(content([0, 600]), null)).toBeNull();
	});
	it("rejects blank titles and oversized content", () => {
		expect(
			validateAiContent({ summary: "", chapters: [{ title: "  ", start: 0 }] }),
		).toContain("needs a title");
		expect(
			validateAiContent({ summary: "x".repeat(50001), chapters: [] }),
		).toContain("summary under");
		expect(
			validateAiContent(
				content(Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => i)),
			),
		).toContain("no more than");
	});
});
