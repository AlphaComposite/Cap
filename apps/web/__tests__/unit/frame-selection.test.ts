import { describe, expect, it } from "vitest";
import { remapEditTranscriptThroughSpec } from "@/lib/edit-transcript";
import {
	previousEditionSpec,
	remapCommentTimestamp,
} from "@/lib/revision-publication-metadata";
import { assertFrameSelection } from "@/lib/revision-publication-origin";
import {
	areEditSpecDocumentsEquivalent,
	getEditSpecOutputDuration,
} from "@/lib/video-edits";

const islands = [
	{ start: 0.5, end: 0.57 },
	{ start: 1, end: 1.07 },
	{ start: 1.5, end: 1.57 },
] as const;
const kept = [
	{ start: 0, end: 0.5 },
	{ start: 0.57, end: 1 },
	{ start: 1.07, end: 1.5 },
	{ start: 1.57, end: 2 },
] as const;
const authored = [
	kept[0],
	islands[0],
	kept[1],
	islands[1],
	kept[2],
	islands[2],
	kept[3],
];

const request = {
	videoId: "fzp57framevid01",
	sourceId: "source-a",
	sourceSha256: "a".repeat(64),
	a1Digest: "b".repeat(64),
	indexId: "index-a",
	keepRanges: authored,
};

function response(overrides: Record<string, unknown> = {}) {
	return {
		sourceId: request.sourceId,
		sourceSha256: request.sourceSha256,
		a1Digest: request.a1Digest,
		indexId: request.indexId,
		keepIndexes: [0, 2, 4, 6],
		keepRanges: kept,
		...overrides,
	};
}

describe("frame selection client", () => {
	it("accepts a source-bound omission and rejects malformed replies", () => {
		expect(assertFrameSelection(request, response())).toEqual(kept);
		expect(() =>
			assertFrameSelection(request, response({ sourceSha256: "c".repeat(64) })),
		).toThrow(/bound/);
		expect(() =>
			assertFrameSelection(request, response({ keepIndexes: [2, 0, 4, 6] })),
		).toThrow(/reorder|expand/);
		expect(() =>
			assertFrameSelection(
				request,
				response({
					keepIndexes: [0],
					keepRanges: [{ start: 0, end: 0.8 }],
				}),
			),
		).toThrow(/reorder|expand/);
		expect(() =>
			assertFrameSelection(
				request,
				response({ keepIndexes: [], keepRanges: [] }),
			),
		).toThrow(/empty/);
		expect(() => assertFrameSelection(request, { keepRanges: kept })).toThrow(
			/malformed/,
		);
	});
});

describe("rendered previous edition", () => {
	it("keeps stored canonical ranges instead of reconstituting omitted islands", () => {
		const sourceDuration = 3;
		const kept = [
			{ start: 0, end: 0.4 },
			{ start: 0.7, end: 1.2 },
			{ start: 1.5, end: 2 },
			{ start: 2.3, end: 3 },
		];
		const stored = {
			version: 2 as const,
			sourceDuration,
			manualKeepRanges: [{ start: 0, end: sourceDuration }],
			keepRanges: kept,
			autoCuts: {
				silence: {
					enabled: true,
					ranges: [
						{ start: 0.4, end: 0.5 },
						{ start: 1.2, end: 1.3 },
						{ start: 2, end: 2.1 },
					],
					thresholdMs: 800,
					padMs: 150,
					removedMs: 300,
					gapCount: 3,
				},
				fillers: {
					enabled: true,
					ranges: [
						{ start: 0.57, end: 0.7 },
						{ start: 1.37, end: 1.5 },
						{ start: 2.17, end: 2.3 },
					],
					mode: "ums" as const,
					padMs: 80,
					removedCount: 3,
					skippedCount: 0,
				},
			},
		};
		const previous = previousEditionSpec({
			currentSpec: stored,
			rollbackSpec: null,
			sourceDuration,
		});
		expect(previous.keepRanges).toEqual(kept);
		if (previous.version !== 2) throw new Error("expected v2");
		expect(previous.manualKeepRanges).toEqual([
			{ start: 0, end: sourceDuration },
		]);
		expect(previous.autoCuts.silence.padMs).toBe(150);
		expect(areEditSpecDocumentsEquivalent(previous, stored)).toBe(true);
		const selectedDuration = getEditSpecOutputDuration(previous);
		const authoredDuration = getEditSpecOutputDuration({
			...stored,
			keepRanges: [
				{ start: 0, end: 0.4 },
				{ start: 0.5, end: 0.57 },
				{ start: 0.7, end: 1.2 },
				{ start: 1.3, end: 1.37 },
				{ start: 1.5, end: 2 },
				{ start: 2.1, end: 2.17 },
				{ start: 2.3, end: 3 },
			],
		});
		expect(authoredDuration - selectedDuration).toBeCloseTo(0.21, 6);
		const transcript = remapEditTranscriptThroughSpec(
			{
				version: 3,
				speechModelUsed: "test",
				durationMs: 3000,
				languageCode: "en",
				words: [
					{
						id: "kept",
						text: "keptword",
						startMs: 100,
						endMs: 200,
						confidence: 1,
						speaker: null,
						channel: null,
					},
					{
						id: "island",
						text: "islandword",
						startMs: 520,
						endMs: 550,
						confidence: 1,
						speaker: null,
						channel: null,
					},
				],
			},
			previous,
		);
		expect(transcript.words.map((word) => word.text)).toEqual(["keptword"]);
		expect(
			remapCommentTimestamp({
				timestamp: 0.535,
				previousSpec: {
					version: 1,
					sourceDuration,
					keepRanges: [{ start: 0, end: sourceDuration }],
				},
				nextSpec: previous.version === 2 ? previous : stored,
			}),
		).toBeNull();
	});
});
