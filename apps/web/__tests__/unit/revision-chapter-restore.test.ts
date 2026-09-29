import { describe, expect, it } from "vitest";
import {
	deriveRevisionChapterState,
	MIN_CHAPTER_SECONDS,
	mergeOwnerChapterEdit,
	outputChaptersToSource,
	projectSourceChapters,
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

	it("keeps a chapter just after 0:00 separate from the opening chapter", () => {
		const cutStart = cut([{ start: 15, end: 100 }]);
		const state = deriveRevisionChapterState({
			storedChapters: [
				{ title: "A", start: 0 },
				{ title: "B", start: 0.0004 },
			],
			storedSourceChapters: null,
			previousSpec: cutStart,
			nextSpec: cutStart,
		});
		expect(state.sourceChapters.map((chapter) => chapter.title)).toEqual([
			"A",
			"B",
		]);
		expect(state.sourceChapters[0]).toEqual({ title: "A", start: 0 });
	});

	it("keeps the opening chapter at 0:00 through an owner rename when the start is cut", () => {
		const cutStart = cut([{ start: 15, end: 100 }]);
		const renamed = mergeOwnerChapterEdit({
			previousSourceChapters: outputChaptersToSource(
				[
					{ title: "A", start: 0 },
					{ title: "B", start: 10 },
				],
				cutStart,
			),
			currentSpec: cutStart,
			editedChapters: [
				{ title: "A renamed", start: 0 },
				{ title: "B", start: 10 },
			],
		});
		expect(renamed).toEqual([
			{ title: "A renamed", start: 0 },
			{ title: "B", start: 25 },
		]);
	});
});

describe("chapters shorter than 10 seconds are hidden after an edit", () => {
	const shortMiddle = cut([
		{ start: 0, end: 35 },
		{ start: 40, end: 100 },
	]);
	const withShortMiddle = [
		{ title: "A", start: 0 },
		{ title: "B", start: 30 },
		{ title: "C", start: 40 },
	];

	it("hides a middle chapter a cut leaves under 10 seconds and shows it again when the cut is restored", () => {
		expect(MIN_CHAPTER_SECONDS).toBe(10);
		const afterCut = deriveRevisionChapterState({
			storedChapters: withShortMiddle,
			storedSourceChapters: null,
			previousSpec: full,
			nextSpec: shortMiddle,
		});
		expect(afterCut.sourceChapters).toEqual(withShortMiddle);
		expect(afterCut.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 35 },
		]);
		const restored = deriveRevisionChapterState({
			storedChapters: afterCut.chapters,
			storedSourceChapters: afterCut.sourceChapters,
			previousSpec: shortMiddle,
			nextSpec: full,
		});
		expect(restored.chapters).toEqual(withShortMiddle);
	});

	it("hides a 4 second opening chapter and starts the next chapter where it began", () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "B", start: 4 },
			{ title: "C", start: 30 },
		];
		const state = deriveRevisionChapterState({
			storedChapters: source,
			storedSourceChapters: source,
			previousSpec: full,
			nextSpec: full,
		});
		expect(state.sourceChapters).toEqual(source);
		expect(state.chapters).toEqual([
			{ title: "B", start: 0 },
			{ title: "C", start: 30 },
		]);
	});

	it("keeps the only chapter on a 7 second video", () => {
		const spec = createIdentityEditSpec(7);
		const only = [{ title: "Only", start: 0 }];
		const state = deriveRevisionChapterState({
			storedChapters: only,
			storedSourceChapters: only,
			previousSpec: spec,
			nextSpec: spec,
		});
		expect(state.chapters).toEqual(only);
	});

	it("keeps a chapter of exactly 10 seconds and hides one of 9.99 seconds", () => {
		const exact = deriveRevisionChapterState({
			storedChapters: [
				{ title: "A", start: 0 },
				{ title: "B", start: 10 },
				{ title: "C", start: 30 },
			],
			storedSourceChapters: null,
			previousSpec: full,
			nextSpec: full,
		});
		expect(exact.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 10 },
			{ title: "C", start: 30 },
		]);
		const under = deriveRevisionChapterState({
			storedChapters: [
				{ title: "A", start: 0 },
				{ title: "B", start: 20 },
				{ title: "C", start: 29.99 },
			],
			storedSourceChapters: null,
			previousSpec: full,
			nextSpec: full,
		});
		expect(under.sourceChapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 20 },
			{ title: "C", start: 29.99 },
		]);
		expect(under.chapters).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 29.99 },
		]);
	});

	it("hides consecutive short chapters deterministically and stays stable", () => {
		const chained = [
			{ title: "A", start: 0 },
			{ title: "B", start: 4 },
			{ title: "C", start: 9 },
		];
		const spec = createIdentityEditSpec(40);
		const projected = projectSourceChapters(chained, spec);
		expect(projected).toEqual([{ title: "C", start: 0 }]);
		expect(projectSourceChapters(chained, spec)).toEqual(projected);
		expect(
			projectSourceChapters(
				[
					{ title: "A", start: 0 },
					{ title: "B", start: 8 },
					{ title: "C", start: 11 },
				],
				spec,
			),
		).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 11 },
		]);
		expect(
			projectSourceChapters(
				[
					{ title: "A", start: 0 },
					{ title: "B", start: 6 },
					{ title: "C", start: 12 },
				],
				createIdentityEditSpec(32),
			),
		).toEqual([
			{ title: "B", start: 0 },
			{ title: "C", start: 12 },
		]);
	});

	it("keeps a length-hidden chapter when the owner edits the visible ones", () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 35 },
		];
		expect(
			mergeOwnerChapterEdit({
				previousSourceChapters: source,
				currentSpec: full,
				editedChapters: [
					{ title: "A renamed", start: 0 },
					{ title: "C", start: 35 },
				],
			}),
		).toEqual([
			{ title: "A renamed", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 35 },
		]);
		expect(
			mergeOwnerChapterEdit({
				previousSourceChapters: [
					{ title: "A", start: 0 },
					{ title: "B", start: 4 },
					{ title: "C", start: 30 },
				],
				currentSpec: full,
				editedChapters: [
					{ title: "B renamed", start: 0 },
					{ title: "C", start: 30 },
				],
			}),
		).toEqual([
			{ title: "A", start: 0 },
			{ title: "B renamed", start: 4 },
			{ title: "C", start: 30 },
		]);
	});

	function expectOwnerListPreserved(
		merged: { title: string; start: number }[],
		ownerList: { title: string; start: number }[],
		spec: Parameters<typeof projectSourceChapters>[1],
		hiddenTitles: string[],
	) {
		const projected = projectSourceChapters(merged, spec);
		expect(projected).toHaveLength(ownerList.length);
		projected.forEach((chapter, index) => {
			expect(chapter.title).toBe(ownerList[index]?.title);
			expect(
				Math.abs(chapter.start - (ownerList[index]?.start ?? 0)),
			).toBeLessThanOrEqual(0.001);
		});
		for (const title of hiddenTitles) {
			expect(merged.some((chapter) => chapter.title === title)).toBe(true);
		}
	}

	it("keeps the owner's chapter when an edit lands on a hidden chapter", () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 35 },
		];
		const ownerList = [
			{ title: "A", start: 0 },
			{ title: "C", start: 30 },
		];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: source,
			currentSpec: full,
			editedChapters: ownerList,
		});
		expect(edited).toEqual([
			{ title: "A", start: 0 },
			{ title: "B", start: 29.999 },
			{ title: "C", start: 30 },
		]);
		expectOwnerListPreserved(edited, ownerList, full, ["B"]);
		expect(30 - 29.999).toBeLessThan(MIN_CHAPTER_SECONDS);
	});

	it("parks a hidden chapter just before a cut edge the owner claims", () => {
		const edge = cut([
			{ start: 0, end: 50 },
			{ start: 80, end: 100 },
		]);
		const source = [
			{ title: "A", start: 0 },
			{ title: "H", start: 80 },
			{ title: "C", start: 85 },
		];
		const ownerList = [
			{ title: "A", start: 0 },
			{ title: "C", start: 50 },
		];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: source,
			currentSpec: edge,
			editedChapters: ownerList,
		});
		expect(edited.find((chapter) => chapter.title === "H")?.start).toBe(79.999);
		expect(edited.find((chapter) => chapter.title === "C")?.start).toBe(80);
		expectOwnerListPreserved(edited, ownerList, edge, ["H"]);
	});

	it("keeps the owner's chapter when a hidden chapter collides at 0", () => {
		const openingCut = cut([{ start: 20, end: 100 }]);
		const source = [
			{ title: "H", start: 0 },
			{ title: "A", start: 20 },
			{ title: "C", start: 60 },
		];
		const ownerList = [{ title: "C", start: 0 }];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: source,
			currentSpec: openingCut,
			editedChapters: ownerList,
		});
		const hidden = edited.find((chapter) => chapter.title === "H");
		expect(hidden?.start).toBe(99.999);
		expectOwnerListPreserved(edited, ownerList, openingCut, ["H"]);
	});

	it("parks hidden chapters that would hide the chapter the owner placed", () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 35 },
			{ title: "E", start: 40 },
		];
		const ownerList = [
			{ title: "A", start: 0 },
			{ title: "E", start: 30 },
		];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: source,
			currentSpec: full,
			editedChapters: ownerList,
		});
		expect(edited).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 29.998 },
			{ title: "B", start: 29.999 },
			{ title: "E", start: 30 },
		]);
		expectOwnerListPreserved(edited, ownerList, full, ["B", "C"]);
	});

	it("parks a collided hidden chapter and the one just after it behind the owner", () => {
		const ownerList = [
			{ title: "A", start: 0 },
			{ title: "C", start: 30 },
		];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: [
				{ title: "A", start: 0 },
				{ title: "B", start: 30 },
				{ title: "D", start: 30.001 },
				{ title: "C", start: 35 },
			],
			currentSpec: full,
			editedChapters: ownerList,
		});
		expect(edited).toEqual([
			{ title: "A", start: 0 },
			{ title: "D", start: 29.998 },
			{ title: "B", start: 29.999 },
			{ title: "C", start: 30 },
		]);
		expectOwnerListPreserved(edited, ownerList, full, ["B", "D"]);
	});

	it("leaves a no-conflict owner edit byte-identical", () => {
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: [
				{ title: "A", start: 0 },
				{ title: "B", start: 30 },
				{ title: "C", start: 35 },
			],
			currentSpec: full,
			editedChapters: [
				{ title: "A renamed", start: 0 },
				{ title: "C", start: 35 },
			],
		});
		expect(JSON.stringify(edited)).toBe(
			JSON.stringify([
				{ title: "A renamed", start: 0 },
				{ title: "B", start: 30 },
				{ title: "C", start: 35 },
			]),
		);
	});

	it("keeps every length-hidden chapter unchanged when the owner only changes titles", () => {
		expect(
			mergeOwnerChapterEdit({
				previousSourceChapters: [
					{ title: "A", start: 0 },
					{ title: "B", start: 30 },
					{ title: "C", start: 35 },
					{ title: "D", start: 36 },
				],
				currentSpec: full,
				editedChapters: [
					{ title: "A renamed", start: 0 },
					{ title: "D renamed", start: 36 },
				],
			}),
		).toEqual([
			{ title: "A renamed", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 35 },
			{ title: "D renamed", start: 36 },
		]);
	});

	it("clears hidden chapters when the owner deletes every visible chapter", () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 35 },
		];
		const edited = mergeOwnerChapterEdit({
			previousSourceChapters: source,
			currentSpec: full,
			editedChapters: [],
		});
		expect(edited).toEqual([]);
		expect(projectSourceChapters(edited, full)).toEqual([]);
	});

	it("projects the same chapters for the editor preview and publication", () => {
		const preview = projectSourceChapters(withShortMiddle, shortMiddle);
		const published = deriveRevisionChapterState({
			storedChapters: withShortMiddle,
			storedSourceChapters: withShortMiddle,
			previousSpec: shortMiddle,
			nextSpec: shortMiddle,
		}).chapters;
		expect(preview).toEqual(published);
		expect(preview).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 35 },
		]);
	});
});
