// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	requestEditTranscript: vi.fn(),
}));
vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: () => ({
		readiness: { transcriptUsable: true },
		checkAgain: () => {},
	}),
}));
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
	CapVideoPlayer: () => createElement("video"),
}));

import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import { createIdentityEditSpec } from "@/lib/video-edits";

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const VIEWPORT_PX = 1000;

async function setInputValue(element: HTMLInputElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function renderEditor(duration: number) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			createElement(EditVideoClient, {
				video: {
					id: "density" as never,
					name: "Density",
					ownerId: "owner-1",
					duration,
					width: 1920,
					height: 1080,
					transcriptionStatus: null,
				},
				chapters: [],
				hasExistingEdits: false,
				initialEditSpec: createIdentityEditSpec(duration),
				playbackSrc: "/original.mp4",
				usesOriginalSource: false,
			}),
		);
	});
	return { container, root };
}

describe("editor waveform editing density", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		globalThis.ResizeObserver =
			ResizeObserverStub as unknown as typeof ResizeObserver;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 404 })),
		);
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get() {
				return VIEWPORT_PX;
			},
		});
		HTMLElement.prototype.scrollTo = () => undefined;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	it("reaches the same 400 px/s ceiling on short and long sources", async () => {
		const seen: number[] = [];
		for (const duration of [60, 3600]) {
			const { container, root } = await renderEditor(duration);
			const slider = container.querySelector(
				"[data-zoom-level]",
			) as HTMLInputElement;
			expect(slider.max).toBe("100");
			expect(slider.step).toBe("1");
			await setInputValue(slider, "50");
			const midpoint = Number(
				container
					.querySelector("[data-editor-timeline]")
					?.getAttribute("data-pixels-per-second"),
			);
			const floor = VIEWPORT_PX / duration;
			expect(midpoint).toBeCloseTo(floor * Math.sqrt(400 / floor), 2);
			await setInputValue(slider, "100");
			const timeline = container.querySelector("[data-editor-timeline]");
			expect(timeline?.getAttribute("data-pixels-per-second")).toBe("400");
			expect(timeline?.getAttribute("data-zoom-mode")).toBe("density");
			seen.push(Number(timeline?.getAttribute("data-visible-seconds")));
			await act(async () => {
				container
					.querySelector("[data-whole-video]")
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(timeline?.getAttribute("data-zoom-mode")).toBe("fit");
			expect(timeline?.getAttribute("style")).toContain("width: 100%");
			expect(
				container.querySelector("[data-zoom-readout]")?.textContent,
			).toContain("Fit");
			await act(async () => {
				container
					.querySelector("[data-zoom-in]")
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(
				Number(timeline?.getAttribute("data-pixels-per-second")),
			).toBeCloseTo((VIEWPORT_PX / duration) * 1.25, 2);
			root.unmount();
			container.remove();
		}
		expect(seen[0]).toBeCloseTo(VIEWPORT_PX / 400, 5);
		expect(seen[1]).toBeCloseTo(seen[0] ?? Number.NaN, 5);
	});
});
