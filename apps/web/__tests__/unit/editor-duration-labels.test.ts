import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/ui", async () => {
	const React = await import("react");
	const Wrapper = ({ children }: { children?: ReactNode }) =>
		React.createElement(React.Fragment, null, children);
	return {
		Button: Wrapper,
		Dialog: Wrapper,
		DialogContent: Wrapper,
		DialogDescription: Wrapper,
		DialogFooter: Wrapper,
		DialogHeader: Wrapper,
		DialogTitle: Wrapper,
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/actions/videos/download", () => ({
	getVideoDownloadInfo: vi.fn(),
}));
vi.mock("@/actions/videos/save-edits", () => ({
	restoreVideoToOriginal: vi.fn(),
	saveVideoEdits: vi.fn(),
}));
vi.mock("@/utils/view-transition", () => ({
	navigateWithTransition: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", () => ({
	CapVideoPlayer: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/video-frame-thumbnail", () => ({
	captureVideoFrameDataUrl: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/edit/EditorChapterPreview", () => ({
	EditorChapterMarkers: () => null,
	useEditorChapterPreview: () => ({ chaptersUrl: null, projectedChapters: [] }),
}));
vi.mock("@/app/s/[videoId]/edit/TranscriptSidebar", () => ({
	TranscriptSidebar: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/use-renewing-playback-source", () => ({
	useRenewingPlaybackSource: ({ initialSrc }: { initialSrc: string }) =>
		initialSrc,
}));

import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import { createIdentityEditSpec, normalizeKeepRanges } from "@/lib/video-edits";

const editedRecording = {
	sourceDuration: 1_037.622333,
	outputDuration: 745.331,
};

function renderEditor(
	duration: number,
	initialEditSpec: ReturnType<typeof createIdentityEditSpec>,
) {
	const html = renderToStaticMarkup(
		createElement(EditVideoClient, {
			video: {
				id: "video-1" as never,
				name: "Timing fixture",
				ownerId: "owner-1",
				duration,
				width: 1920,
				height: 1080,
				transcriptionStatus: null,
			},
			chapters: [],
			hasExistingEdits: true,
			initialEditSpec,
			playbackSrc: "/original.mp4",
			usesOriginalSource: true,
		}),
	);
	return new JSDOM(html).window.document;
}

describe("editor duration labels", () => {
	it("labels a shortened output clock Edited beside 12:25", () => {
		const initialEditSpec = normalizeKeepRanges(
			[
				{ start: 0, end: 400 },
				{ start: 500, end: 845.331 },
			],
			editedRecording.sourceDuration,
		);
		const document = renderEditor(
			editedRecording.sourceDuration,
			initialEditSpec,
		);
		const label = [...document.querySelectorAll("span")].find(
			(span) => span.textContent?.trim() === "Edited",
		);

		expect(label).toBeDefined();
		expect(label?.parentElement?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"Edited 12:25",
		);
		expect(label?.parentElement?.parentElement?.textContent).toContain("0:00");
	});

	it("labels an unedited output clock Original", () => {
		const duration = 1_972.9;
		const document = renderEditor(duration, createIdentityEditSpec(duration));
		const label = [...document.querySelectorAll("span")].find(
			(span) => span.textContent?.trim() === "Original",
		);

		expect(label).toBeDefined();
		expect(label?.parentElement?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"Original 32:52",
		);
	});
});
