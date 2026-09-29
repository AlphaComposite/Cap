// @vitest-environment jsdom

import type { VideoEditSpec } from "@cap/database/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EditorChapterMarkers,
	useEditorChapterPreview,
} from "@/app/s/[videoId]/edit/EditorChapterPreview";
import { deriveRevisionChapterState } from "@/lib/revision-chapter-source";
import {
	getEditSpecOutputDuration,
	normalizeVideoEditSpec,
} from "@/lib/video-edits";

const chapters = [
	{ title: "Opening", start: 1 },
	{ title: "Inside silence", start: 3 },
	{ title: "Inside filler", start: 6.5 },
	{ title: "Tail fallback", start: 9.5 },
];
const initialEditSpec: VideoEditSpec = {
	version: 1,
	sourceDuration: 10,
	keepRanges: [{ start: 0, end: 10 }],
};

function createSpec(silence: boolean, fillers: boolean) {
	return normalizeVideoEditSpec({
		version: 2,
		sourceDuration: 10,
		manualKeepRanges: [{ start: 0, end: 8 }],
		keepRanges: [],
		autoCuts: {
			silence: {
				enabled: silence,
				ranges: [{ start: 2, end: 4 }],
				thresholdMs: 800,
				padMs: 150,
				removedMs: 2_000,
				gapCount: 1,
			},
			fillers: {
				enabled: fillers,
				ranges: [{ start: 6, end: 7.5 }],
				mode: "ums",
				padMs: 80,
				removedCount: 1,
				skippedCount: 0,
			},
		},
	});
}

function Harness({
	editSpec,
	sourceChapters,
}: {
	editSpec: VideoEditSpec;
	sourceChapters?: { title: string; start: number }[] | null;
}) {
	const preview = useEditorChapterPreview({
		chapters,
		sourceChapters,
		initialEditSpec,
		editSpec,
	});
	return createElement(
		"div",
		null,
		createElement(
			"output",
			{ "data-testid": "chapters-url" },
			preview.chaptersUrl ?? "",
		),
		createElement(EditorChapterMarkers, {
			chapters: preview.projectedChapters,
			outputDuration: getEditSpecOutputDuration(editSpec),
		}),
	);
}

function readBlob(blob: Blob | undefined) {
	if (!blob) throw new Error("Expected chapter VTT blob");
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => resolve(String(reader.result)));
		reader.addEventListener("error", () => reject(reader.error));
		reader.readAsText(blob);
	});
}

describe("editor chapter preview", () => {
	let root: Root;
	let container: HTMLDivElement;
	let blobs: Blob[];

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		blobs = [];
		vi.stubGlobal("URL", {
			createObjectURL: vi.fn((blob: Blob) => {
				blobs.push(blob);
				return `blob:chapters-${blobs.length}`;
			}),
			revokeObjectURL: vi.fn(),
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("updates VTT and visible markers for auto-cut toggles then restores exactly", async () => {
		const everyLayer = createSpec(true, true);
		await act(async () =>
			root.render(createElement(Harness, { editSpec: everyLayer })),
		);

		const originalVtt = await readBlob(blobs.at(-1));
		const originalMarkers = [
			...container.querySelectorAll('[aria-label^="Chapter:"]'),
		].map((marker) => ({
			label: marker.getAttribute("aria-label"),
			left: (marker as HTMLElement).style.left,
		}));
		expect(originalVtt).toContain("00:00:04.000 -->");
		expect(originalVtt).toContain("Inside silence");
		expect(originalVtt).toContain("00:00:07.500 -->");
		expect(originalVtt).toContain("Inside filler");
		expect(originalVtt).toContain("00:00:08.000 -->");
		expect(originalVtt).toContain("Tail fallback");
		expect(originalMarkers.map(({ label }) => label)).toEqual([
			"Chapter: Opening",
			"Chapter: Inside silence",
			"Chapter: Inside filler",
		]);
		[22.2222, 44.4444, 88.8889].forEach((expected, index) => {
			expect(Number.parseFloat(originalMarkers[index]?.left ?? "")).toBeCloseTo(
				expected,
				4,
			);
		});

		await act(async () =>
			root.render(
				createElement(Harness, { editSpec: createSpec(false, true) }),
			),
		);
		expect(await readBlob(blobs.at(-1))).toContain("00:00:03.000 -->");
		expect(
			Number.parseFloat(
				(
					container.querySelector(
						'[aria-label="Chapter: Inside silence"]',
					) as HTMLElement
				).style.left,
			),
		).toBeCloseTo(46.1538, 4);

		await act(async () =>
			root.render(
				createElement(Harness, { editSpec: createSpec(false, false) }),
			),
		);
		expect(await readBlob(blobs.at(-1))).toContain("00:00:06.500 -->");
		expect(
			Number.parseFloat(
				(
					container.querySelector(
						'[aria-label="Chapter: Inside filler"]',
					) as HTMLElement
				).style.left,
			),
		).toBeCloseTo(81.25, 4);

		await act(async () =>
			root.render(createElement(Harness, { editSpec: everyLayer })),
		);
		expect(await readBlob(blobs.at(-1))).toBe(originalVtt);
		expect(
			[...container.querySelectorAll('[aria-label^="Chapter:"]')].map(
				(marker) => ({
					label: marker.getAttribute("aria-label"),
					left: (marker as HTMLElement).style.left,
				}),
			),
		).toEqual(originalMarkers);
	});

	it("keeps one chapter when a flagged cut leaves every chapter under 10 seconds", async () => {
		const cutSection = normalizeVideoEditSpec({
			version: 1,
			sourceDuration: 10,
			keepRanges: [
				{ start: 0, end: 2.5 },
				{ start: 7, end: 10 },
			],
		});
		await act(async () =>
			root.render(
				createElement(Harness, {
					editSpec: cutSection,
					sourceChapters: null,
				}),
			),
		);
		const vtt = await readBlob(blobs.at(-1));
		expect(vtt).toContain("Inside filler");
		expect(vtt).not.toContain("Opening");
		expect(vtt).not.toContain("Inside silence");
		expect(vtt).not.toContain("Tail fallback");
	});

	it("agrees with publication when source chapters exist and a cut leaves one under 10 seconds", async () => {
		const sourceChapters = [
			{ title: "A", start: 0 },
			{ title: "B", start: 30 },
			{ title: "C", start: 40 },
		];
		const spec = normalizeVideoEditSpec({
			version: 1,
			sourceDuration: 100,
			keepRanges: [
				{ start: 0, end: 35 },
				{ start: 40, end: 100 },
			],
		});
		let projected: { title: string; start: number }[] = [];
		function AgreeHarness() {
			const preview = useEditorChapterPreview({
				chapters: sourceChapters,
				sourceChapters,
				initialEditSpec: spec,
				editSpec: spec,
			});
			projected = preview.projectedChapters;
			return null;
		}
		await act(async () => root.render(createElement(AgreeHarness)));
		const published = deriveRevisionChapterState({
			storedChapters: sourceChapters,
			storedSourceChapters: sourceChapters,
			previousSpec: spec,
			nextSpec: spec,
		}).chapters;
		expect(projected).toEqual(published);
		expect(projected).toEqual([
			{ title: "A", start: 0 },
			{ title: "C", start: 35 },
		]);
	});

	it("previews the opening chapter at 0:00 after the cut start is restored", async () => {
		const cutStart = normalizeVideoEditSpec({
			version: 1,
			sourceDuration: 10,
			keepRanges: [{ start: 2, end: 10 }],
		});
		const openingChapters = [{ title: "Opening", start: 0 }];
		let projected: { title: string; start: number }[] = [];
		function StartHarness({ editSpec }: { editSpec: VideoEditSpec }) {
			const preview = useEditorChapterPreview({
				chapters: openingChapters,
				sourceChapters: null,
				initialEditSpec: cutStart,
				editSpec,
			});
			projected = preview.projectedChapters;
			return null;
		}
		await act(async () =>
			root.render(createElement(StartHarness, { editSpec: initialEditSpec })),
		);
		expect(projected).toEqual([{ title: "Opening", start: 0 }]);
	});
});
