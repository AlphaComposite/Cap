import { describe, expect, it } from "vitest";
import { resolveRevisionChapters } from "@/lib/revision-metadata-snapshot";
import { chaptersAfterRevert } from "@/lib/revision-publication-metadata";
import {
	createIdentityEditSpec,
	normalizeVideoEditSpec,
} from "@/lib/video-edits";

const snapshot = [
	{ title: "A", start: 0 },
	{ title: "B", start: 40 },
];

describe("resolveRevisionChapters", () => {
	it("shows owner chapters saved for the current revision", () => {
		const live = [{ title: "Owner", start: 5 }];
		expect(
			resolveRevisionChapters({
				currentRevisionId: "r2",
				snapshotChapters: snapshot,
				liveChapters: live,
				liveChaptersRevisionId: "r2",
			}),
		).toEqual(live);
	});

	it("ignores row chapters from another edition, even with the same length", () => {
		expect(
			resolveRevisionChapters({
				currentRevisionId: "r2",
				snapshotChapters: snapshot,
				liveChapters: [{ title: "Old", start: 69 }],
				liveChaptersRevisionId: "r1",
			}),
		).toEqual(snapshot);
		expect(
			resolveRevisionChapters({
				currentRevisionId: "r2",
				snapshotChapters: snapshot,
				liveChapters: [{ title: "Legacy", start: 69 }],
				liveChaptersRevisionId: undefined,
			}),
		).toEqual(snapshot);
	});
});

describe("chaptersAfterRevert", () => {
	const previousSpec = createIdentityEditSpec(100);
	const failedSpec = normalizeVideoEditSpec({
		version: 1,
		sourceDuration: 100,
		keepRanges: [
			{ start: 0, end: 20 },
			{ start: 50, end: 100 },
		],
	});
	const published = [
		{ title: "A", start: 0 },
		{ title: "C", start: 20 },
	];

	it("restores the previous chapters when the owner did not edit them", () => {
		expect(
			chaptersAfterRevert({
				rowChapters: published,
				publishedChapters: published,
				previousChapters: [
					{ title: "A", start: 0 },
					{ title: "B", start: 30 },
					{ title: "C", start: 50 },
				],
				failedSpec,
				previousSpec,
			}),
		).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 50 },
		]);
	});

	it("keeps an owner edit made before the revert, moved back to the previous timeline", () => {
		expect(
			chaptersAfterRevert({
				rowChapters: [
					{ title: "A", start: 0 },
					{ title: "Renamed", start: 30 },
				],
				publishedChapters: published,
				previousChapters: null,
				failedSpec,
				previousSpec,
			}),
		).toEqual([
			{ title: "A", start: 0 },
			{ title: "Renamed", start: 60 },
		]);
	});
});
