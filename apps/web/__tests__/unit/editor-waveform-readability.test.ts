import { JSDOM } from "jsdom";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	requestEditTranscript: vi.fn(),
}));
vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: () => ({
		readiness: { transcriptUsable: true },
		checkAgain: () => {},
	}),
}));
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
vi.mock("@/actions/videos/publish-revision", () => ({
	getEditorInstantFinishState: vi.fn(async () => null),
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
	useEditorChapterPreview: () => ({
		chaptersUrl: null,
		playbackChapters: [],
		projectedChapters: [],
	}),
}));
vi.mock("@/app/s/[videoId]/edit/TranscriptSidebar", () => ({
	TranscriptSidebar: () =>
		createElement("aside", { "data-transcript-sidebar": "" }),
}));
vi.mock("@/app/s/[videoId]/edit/use-renewing-playback-source", () => ({
	useRenewingPlaybackSource: ({ initialSrc }: { initialSrc: string }) =>
		initialSrc,
}));

import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import { createIdentityEditSpec } from "@/lib/video-edits";

function renderEditor(transcriptionStatus: string | null) {
	const duration = 142.94;
	const html = renderToStaticMarkup(
		createElement(EditVideoClient, {
			video: {
				id: "video-readability" as never,
				name: "Waveform readability",
				ownerId: "owner-1",
				duration,
				width: 1920,
				height: 1080,
				transcriptionStatus,
			},
			chapters: [],
			hasExistingEdits: false,
			initialEditSpec: createIdentityEditSpec(duration),
			playbackSrc: "/original.mp4",
			usesOriginalSource: false,
		}),
	);
	return new JSDOM(html).window.document;
}

describe("editor waveform dock", () => {
	it("places the timeline, toolbar, and split/delete below both columns", () => {
		const document = renderEditor("COMPLETE");
		const shell = document.querySelector("[data-editor-shell='editor']");
		const main = document.querySelector("main");
		const dock = document.querySelector("[data-editor-dock]");
		const timeline = document.querySelector("[data-editor-timeline]");
		const sidebar = document.querySelector("[data-transcript-sidebar]");
		const player = document.querySelector("[style*='view-transition-name']");

		expect(dock).not.toBeNull();
		expect(dock?.contains(timeline)).toBe(true);
		expect(main?.contains(timeline)).toBe(false);
		expect(
			dock?.contains(document.querySelector("[data-waveform-toolbar]")),
		).toBe(true);
		expect(dock?.contains(document.querySelector("[data-chapter-lane]"))).toBe(
			true,
		);
		expect(dock?.textContent).toContain("Split");
		expect(dock?.textContent).toContain("Delete");
		expect(main?.textContent).not.toContain("Split");
		expect(main?.contains(player)).toBe(true);
		expect(main?.className).toContain("xl:pr-[640px]");
		expect(dock?.className ?? "").not.toContain("xl:pr-[640px]");
		expect(shell?.getAttribute("style") ?? "").toContain(
			"--editor-dock-height",
		);
		expect(sidebar).not.toBeNull();
		const position = document.defaultView?.Node.DOCUMENT_POSITION_PRECEDING;
		if (!dock || !sidebar || position === undefined) {
			throw new Error("missing dock geometry");
		}
		expect(dock.compareDocumentPosition(sidebar) & position).not.toBe(0);
	});
});
