import { describe, expect, it } from "vitest";
import {
	deriveRevisionChapterState,
	mergeOwnerChapterEdit,
} from "@/lib/revision-chapter-source";
import {
	createIdentityEditSpec,
	normalizeVideoEditSpec,
} from "@/lib/video-edits";

const full = createIdentityEditSpec(100);
const cut = (ranges: { start: number; end: number }[]) =>
	normalizeVideoEditSpec({
		version: 1,
		sourceDuration: 100,
		keepRanges: ranges,
	});
const chapters = [
	{ title: "A", start: 0 },
	{ title: "B", start: 30 },
	{ title: "C", start: 70 },
];

describe("chapters come back when a cut section is restored", () => {
	it("hides a chapter inside a cut and restores it when the cut is undone", () => {
		const cutSpec = cut([
			{ start: 0, end: 20 },
			{ start: 70, end: 100 },
		]);
		const afterCut = deriveRevisionChapterState({
			storedChapters: chapters,
			storedSourceChapters: null,
			previousSpec: full,
			nextSpec: cutSpec,
		});
		expect(afterCut.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 20 },
		]);
		const restored = deriveRevisionChapterState({
			storedChapters: afterCut.chapters,
			storedSourceChapters: afterCut.sourceChapters,
			previousSpec: cutSpec,
			nextSpec: full,
		});
		expect(restored.chapters).toEqual(chapters);
	});

	it("keeps a partly cut chapter visible and restores its original start after an owner rename", () => {
		const cutSpec = cut([
			{ start: 0, end: 20 },
			{ start: 50, end: 100 },
		]);
		const afterCut = deriveRevisionChapterState({
			storedChapters: chapters,
			storedSourceChapters: null,
			previousSpec: full,
			nextSpec: cutSpec,
		});
		expect(afterCut.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 20 },
			{ title: "C", start: 40 },
		]);
		const visibleEdit = [
			{ title: "A", start: 0 },
			{ title: "B", start: 20 },
			{ title: "C renamed", start: 40 },
		];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: afterCut.sourceChapters,
			currentSpec: cutSpec,
			editedChapters: visibleEdit,
		});
		const restored = deriveRevisionChapterState({
			storedChapters: visibleEdit,
			storedSourceChapters: edited,
			previousSpec: cutSpec,
			nextSpec: full,
		});
		expect(restored.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C renamed", start: 70 },
		]);
	});

	it("keeps a hidden chapter through an owner edit of the visible ones", () => {
		const cutSpec = cut([
			{ start: 0, end: 20 },
			{ start: 70, end: 100 },
		]);
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: chapters,
			currentSpec: cutSpec,
			editedChapters: [
				{ title: "A renamed", start: 0 },
				{ title: "C", start: 20 },
			],
		});
		expect(edited).toEqual([
			{ title: "A renamed", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 70 },
		]);
	});

	it("drops a chapter only when the owner deletes it, not when it is cut", () => {
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: chapters,
			currentSpec: full,
			editedChapters: [
				{ title: "A", start: 0 },
				{ title: "C", start: 70 },
			],
		});
		expect(edited).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 70 },
		]);
	});

	it("uses the visible chapters as the source list for rows without one", () => {
		const state = deriveRevisionChapterState({
			storedChapters: chapters,
			storedSourceChapters: null,
			previousSpec: full,
			nextSpec: full,
		});
		expect(state.sourceChapters).toEqual(chapters);
		expect(state.chapters).toEqual(chapters);
	});

	it("keeps two chapters one millisecond apart as separate chapters", () => {
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: [{ title: "A", start: 1 }],
			currentSpec: full,
			editedChapters: [
				{ title: "A", start: 1 },
				{ title: "B", start: 1.001 },
			],
		});
		expect(edited).toEqual([
			{ title: "A", start: 1 },
			{ title: "B", start: 1.001 },
		]);
	});

	it("keeps the first chapter at 0:00 when the start of the video was cut and is restored", () => {
		const cutStart = cut([{ start: 15, end: 100 }]);
		const afterCut = deriveRevisionChapterState({
			storedChapters: [
				{ title: "A", start: 0 },
				{ title: "B", start: 10 },
			],
			storedSourceChapters: null,
			previousSpec: cutStart,
			nextSpec: cutStart,
		});
		expect(afterCut.sourceChapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 25 },
		]);
		expect(afterCut.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 10 },
		]);
		const restored = deriveRevisionChapterState({
			storedChapters: afterCut.chapters,
			storedSourceChapters: afterCut.sourceChapters,
			previousSpec: cutStart,
			nextSpec: full,
		});
		expect(restored.chapters[0]).toEqual({ title: "A", start: 0 });
	});
});
