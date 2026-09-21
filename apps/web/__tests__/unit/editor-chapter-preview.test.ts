// @vitest-environment jsdom

import type { VideoEditSpec } from "@cap/database/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EditorChapterMarkers,
	useEditorChapterPreview,
} from "@/app/s/[videoId]/edit/EditorChapterPreview";
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

function Harness({ editSpec }: { editSpec: VideoEditSpec }) {
	const preview = useEditorChapterPreview({
		chapters,
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
});
