// @vitest-environment jsdom

import {
	act,
	createElement,
	type ReactNode,
	useLayoutEffect,
	useRef,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
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
vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/video-frame-thumbnail", () => ({
	captureVideoFrameDataUrl: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/edit/TranscriptSidebar", () => ({
	TranscriptSidebar: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/use-renewing-playback-source", () => ({
	useRenewingPlaybackSource: ({ initialSrc }: { initialSrc: string }) =>
		initialSrc,
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
vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", () => ({
	CapVideoPlayer: ({
		videoRef,
	}: {
		videoRef?: { current: HTMLVideoElement | null };
	}) => {
		const nodeRef = useRef<HTMLVideoElement | null>(null);
		useLayoutEffect(() => {
			if (!videoRef) return;
			videoRef.current = nodeRef.current;
			return () => {
				videoRef.current = null;
			};
		});
		return createElement("video", {
			ref: nodeRef,
			"data-editor-preview": "true",
		});
	},
}));

import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import { normalizeKeepRanges } from "@/lib/video-edits";

const DURATION = 10;
const cutSpec = normalizeKeepRanges(
	[
		{ start: 0, end: 4 },
		{ start: 6, end: DURATION },
	],
	DURATION,
);

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let container: HTMLDivElement;
let root: Root;

function leadingPercent(value: string) {
	const match = value.match(/(-?\d+(?:\.\d+)?)%/);
	if (!match?.[1]) throw new Error(`no percent in ${value}`);
	return Number(match[1]);
}

function keptClipBoxes(rootNode: ParentNode) {
	return [...rootNode.querySelectorAll("div")].filter((element) => {
		const bars = [...element.children].filter(
			(child) =>
				child.tagName === "DIV" && child.classList.contains("bg-blue-500"),
		);
		return bars.length >= 2;
	});
}

function timelineElement(rootNode: ParentNode) {
	const timeline = [...rootNode.querySelectorAll("div")].find(
		(element) =>
			element.className.includes("cursor-pointer") &&
			element.querySelector(".bg-blue-500"),
	);
	if (!timeline) throw new Error("missing timeline");
	return timeline;
}

async function renderEditor(chapters: { title: string; start: number }[] = []) {
	await act(async () => {
		root.render(
			createElement(EditVideoClient, {
				video: {
					id: "timeline-source" as never,
					name: "Source timeline",
					ownerId: "owner-1",
					duration: DURATION,
					width: 1920,
					height: 1080,
					transcriptionStatus: null,
				},
				chapters,
				hasExistingEdits: true,
				initialEditSpec: cutSpec,
				playbackSrc: "/original.mp4",
				usesOriginalSource: false,
			}),
		);
	});
}

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof globalThis.ResizeObserver !== "function") {
		globalThis.ResizeObserver =
			ResizeObserverStub as unknown as typeof ResizeObserver;
	}
	const url = URL as typeof URL & {
		createObjectURL?: (blob: Blob) => string;
		revokeObjectURL?: (url: string) => void;
	};
	if (typeof url.createObjectURL !== "function") {
		url.createObjectURL = () => "blob:chapters";
		url.revokeObjectURL = () => {};
	}
	localStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("editor source timeline", () => {
	it("keeps a middle deletion in place instead of collapsing the filmstrip", async () => {
		await renderEditor();
		const deleted = container.querySelector("[data-timeline-deleted]");
		const clips = keptClipBoxes(container);

		expect(clips).toHaveLength(2);
		expect(leadingPercent(clips[0]?.getAttribute("style") ?? "")).toBeCloseTo(
			0,
		);
		expect(leadingPercent(clips[0]?.style.width ?? "")).toBeCloseTo(40);
		expect(leadingPercent(clips[1]?.style.left ?? "")).toBeCloseTo(60);
		expect(leadingPercent(clips[1]?.style.width ?? "")).toBeCloseTo(40);
		expect(deleted).not.toBeNull();
		expect(deleted?.getAttribute("aria-label")).toBe(
			"Removed section 0:04–0:06",
		);
		expect((deleted as HTMLElement).style.left).toBe("40%");
		expect((deleted as HTMLElement).style.width).toBe("20%");
		expect(container.textContent).toContain("Edited 0:08");
	});

	it("seeks a click at 50% to the next playable source time", async () => {
		await renderEditor();
		const timeline = timelineElement(container);
		const preview = container.querySelector(
			"[data-editor-preview]",
		) as HTMLVideoElement;
		timeline.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				left: 0,
				top: 0,
				right: 1000,
				bottom: 64,
				width: 1000,
				height: 64,
				toJSON() {
					return {};
				},
			}) as DOMRect;

		await act(async () => {
			timeline.dispatchEvent(
				new MouseEvent("pointerdown", {
					bubbles: true,
					cancelable: true,
					button: 0,
					clientX: 500,
					clientY: 32,
				}),
			);
		});

		expect(preview.currentTime).toBe(6);
		expect(container.textContent).toContain("00:04.00");
		expect(container.textContent).not.toContain("00:06.00");
	});

	it("steps backward over a removed section with the left arrow", async () => {
		await renderEditor();
		const timeline = timelineElement(container);
		const preview = container.querySelector(
			"[data-editor-preview]",
		) as HTMLVideoElement;
		timeline.getBoundingClientRect = () =>
			({
				x: 0,
				y: 0,
				left: 0,
				top: 0,
				right: 1000,
				bottom: 64,
				width: 1000,
				height: 64,
				toJSON() {
					return {};
				},
			}) as DOMRect;
		await act(async () => {
			timeline.dispatchEvent(
				new MouseEvent("pointerdown", {
					bubbles: true,
					cancelable: true,
					button: 0,
					clientX: 600,
					clientY: 32,
				}),
			);
		});
		expect(preview.currentTime).toBe(6);

		await act(async () => {
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
			);
		});
		await act(async () => {
			preview.dispatchEvent(new Event("seeking"));
			preview.dispatchEvent(new Event("timeupdate"));
		});

		expect(preview.currentTime).toBeGreaterThan(3.9);
		expect(preview.currentTime).toBeLessThan(4);
	});

	it("places an output chapter at its source time on the full timeline", async () => {
		await renderEditor([{ title: "Middle", start: 5 }]);
		const marker = container.querySelector(
			'[aria-label="Chapter: Middle"]',
		) as HTMLElement | null;

		expect(marker).not.toBeNull();
		expect(Number.parseFloat(marker?.style.left ?? "")).toBeCloseTo(70, 4);
	});
});
