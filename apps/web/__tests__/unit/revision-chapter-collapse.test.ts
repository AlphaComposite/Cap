import type { VideoEditSpecV2 } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import { validateAiContent } from "@/lib/ai-content";
import { deriveRevisionChapters } from "@/lib/revision-publication-metadata";
import { createIdentityEditSpec } from "@/lib/video-edits";

function keep(ranges: { start: number; end: number }[]): VideoEditSpecV2 {
	return {
		version: 2,
		sourceDuration: 100,
		manualKeepRanges: ranges,
		keepRanges: ranges,
		autoCuts: {
			silence: {
				enabled: false,
				ranges: [],
				thresholdMs: 0,
				padMs: 0,
				removedMs: 0,
			},
			filler: { enabled: false, ranges: [], words: [], removedMs: 0 },
		},
		autoCutsInitialized: true,
	} as unknown as VideoEditSpecV2;
}

const stored = [
	{ title: "A", start: 0 },
	{ title: "B", start: 30 },
	{ title: "C", start: 40 },
	{ title: "D", start: 70 },
	{ title: "E", start: 80 },
];

describe("deriveRevisionChapters after a cut", () => {
	it("drops chapters inside a removed tail so the output stays valid", () => {
		const nextSpec = keep([{ start: 0, end: 60 }]);
		const chapters = deriveRevisionChapters({
			storedChapters: stored,
			previousSpec: createIdentityEditSpec(100),
			nextSpec,
		});
		expect(chapters.map((c) => c.title)).toEqual(["A", "B", "C"]);
		expect(validateAiContent({ summary: "s", chapters }, 60)).toBeNull();
	});

	it("keeps one chapter where removed chapters collapse onto the same point", () => {
		const nextSpec = keep([
			{ start: 0, end: 25 },
			{ start: 50, end: 100 },
		]);
		const chapters = deriveRevisionChapters({
			storedChapters: stored,
			previousSpec: createIdentityEditSpec(100),
			nextSpec,
		});
		expect(chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 25 },
			{ title: "D", start: 45 },
			{ title: "E", start: 55 },
		]);
		expect(validateAiContent({ summary: "s", chapters }, 75)).toBeNull();
	});
});
