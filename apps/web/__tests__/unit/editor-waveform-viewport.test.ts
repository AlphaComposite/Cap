// @vitest-environment jsdom

import { act, createElement, type ReactNode, type Ref } from "react";
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
	CapVideoPlayer: ({ videoRef }: { videoRef?: Ref<HTMLVideoElement> }) =>
		createElement("video", { ref: videoRef }),
}));

import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import { createIdentityEditSpec } from "@/lib/video-edits";

class ResizeObserverStub {
	static callbacks: ResizeObserverCallback[] = [];

	constructor(callback: ResizeObserverCallback) {
		ResizeObserverStub.callbacks.push(callback);
	}

	observe() {}
	unobserve() {}
	disconnect() {}
}

const DURATION = 60;
const roots: { unmount: () => void }[] = [];
let viewportPx = 1000;
const frames: FrameRequestCallback[] = [];

function timelineWidth(node: HTMLElement) {
	const style = node.style.width.trim();
	const px = /^([\d.]+)px$/.exec(style);
	if (px) return Number(px[1]);
	const percent = /^([\d.]+)%$/.exec(style);
	if (percent) return (viewportPx * Number(percent[1])) / 100;
	return viewportPx;
}

function clampScrollToRenderedWidth(port: HTMLElement) {
	const timeline = port.querySelector(
		"[data-editor-timeline]",
	) as HTMLElement | null;
	if (!timeline) return;
	const max = Math.max(0, timelineWidth(timeline) - port.clientWidth);
	if (port.scrollLeft > max) port.scrollLeft = max;
	if (port.scrollLeft < 0) port.scrollLeft = 0;
}

function sliderOnChange(slider: HTMLInputElement) {
	const key = Object.keys(slider).find((name) =>
		name.startsWith("__reactProps$"),
	);
	if (!key) throw new Error("missing slider props");
	const onChange = (
		slider as unknown as Record<
			string,
			{ onChange?: (event: { target: HTMLInputElement }) => void }
		>
	)[key]?.onChange;
	if (!onChange) throw new Error("missing slider onChange");
	return onChange;
}

function dispatchModifierWheel(
	port: HTMLElement,
	clientX: number,
	deltaY = -120,
) {
	port.dispatchEvent(
		new WheelEvent("wheel", {
			deltaY,
			ctrlKey: true,
			clientX,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function scrollport(container: HTMLElement) {
	const timeline = container.querySelector("[data-editor-timeline]");
	if (!timeline?.parentElement) throw new Error("missing scrollport");
	return timeline.parentElement;
}

function pixelsPerSecond(container: HTMLElement) {
	return Number(
		container
			.querySelector("[data-editor-timeline]")
			?.getAttribute("data-pixels-per-second"),
	);
}

function zoomMode(container: HTMLElement) {
	return container
		.querySelector("[data-editor-timeline]")
		?.getAttribute("data-zoom-mode");
}

async function setInputValue(element: HTMLInputElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

async function flushFrames() {
	await act(async () => {
		const pending = frames.splice(0);
		for (const frame of pending) frame(0);
	});
}

async function renderEditor() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			createElement(EditVideoClient, {
				video: {
					id: "viewport" as never,
					name: "Viewport",
					ownerId: "owner-1",
					duration: DURATION,
					width: 1920,
					height: 1080,
					transcriptionStatus: null,
				},
				chapters: [],
				hasExistingEdits: false,
				initialEditSpec: createIdentityEditSpec(DURATION),
				playbackSrc: "/original.mp4",
				usesOriginalSource: false,
			}),
		);
	});
	await flushFrames();
	roots.push(root);
	return { container, root };
}

describe("editor waveform viewport anchors", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		viewportPx = 1000;
		frames.length = 0;
		ResizeObserverStub.callbacks = [];
		globalThis.ResizeObserver =
			ResizeObserverStub as unknown as typeof ResizeObserver;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 404 })),
		);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get() {
				return viewportPx;
			},
		});
		Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
			configurable: true,
			get() {
				const timeline = this.querySelector?.(
					"[data-editor-timeline]",
				) as HTMLElement | null;
				if (timeline && timeline !== this) return timelineWidth(timeline);
				if (this.getAttribute?.("data-editor-timeline") === "") {
					return timelineWidth(this);
				}
				return viewportPx;
			},
		});
		HTMLElement.prototype.getBoundingClientRect = function () {
			const width =
				this.getAttribute("data-editor-timeline") === ""
					? timelineWidth(this)
					: viewportPx;
			return {
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: width,
				bottom: 64,
				width,
				height: 64,
				toJSON() {
					return {};
				},
			} as DOMRect;
		};
		HTMLElement.prototype.scrollTo = function (
			options?: ScrollToOptions | number,
		) {
			if (typeof options === "object" && options && "left" in options) {
				this.scrollLeft = options.left ?? 0;
			}
		};
	});

	afterEach(() => {
		for (const root of roots.splice(0)) {
			act(() => {
				root.unmount();
			});
		}
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	it("keeps the newer pan when a stale zoom correction lands", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "100");
		const port = scrollport(container);
		port.scrollLeft = 4321;
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushFrames();
		expect(port.scrollLeft).toBe(4321);
		expect(pixelsPerSecond(container)).toBe(400);
	});

	it("preserves pointed source time and viewport-center time", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "40");
		await flushFrames();
		const port = scrollport(container);
		port.scrollLeft = 2000;
		const before = pixelsPerSecond(container);
		const pointerX = 250;
		port.dispatchEvent(
			new WheelEvent("wheel", {
				deltaY: -120,
				ctrlKey: true,
				clientX: pointerX,
				bubbles: true,
				cancelable: true,
			}),
		);
		await flushFrames();
		const pointed = (2000 + pointerX) / before;
		const afterPointer = pixelsPerSecond(container);
		expect(afterPointer).toBeCloseTo(before * 1.25, 2);
		expect(port.scrollLeft).toBeCloseTo(pointed * afterPointer - pointerX, 0);

		const centerBefore = port.scrollLeft;
		const centerPps = pixelsPerSecond(container);
		const centerTime = (centerBefore + viewportPx / 2) / centerPps;
		container
			.querySelector("[data-zoom-in]")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await act(async () => undefined);
		await flushFrames();
		const centerAfter = pixelsPerSecond(container);
		expect(centerAfter).toBeCloseTo(centerPps * 1.25, 2);
		expect(port.scrollLeft).toBeCloseTo(
			centerTime * centerAfter - viewportPx / 2,
			0,
		);

		const ordinary = pixelsPerSecond(container);
		port.dispatchEvent(
			new WheelEvent("wheel", {
				deltaY: -120,
				bubbles: true,
				cancelable: true,
			}),
		);
		await flushFrames();
		expect(pixelsPerSecond(container)).toBeCloseTo(ordinary, 2);
	});

	it("retains density and center source time across resize, edits, and manual inspection", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "100");
		await flushFrames();
		const port = scrollport(container);
		port.scrollLeft = 2000;
		const pps = pixelsPerSecond(container);
		const center = (2000 + viewportPx / 2) / pps;

		viewportPx = 800;
		clampScrollToRenderedWidth(port);
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(pixelsPerSecond(container)).toBeCloseTo(pps, 2);
		expect(zoomMode(container)).toBe("density");
		expect(port.scrollLeft).toBeCloseTo(center * pps - viewportPx / 2, 0);

		const timeline = container.querySelector(
			"[data-editor-timeline]",
		) as HTMLElement;
		timeline.dispatchEvent(
			new MouseEvent("pointerdown", {
				button: 0,
				clientX: timeline.getBoundingClientRect().width / 2,
				bubbles: true,
			}),
		);
		await act(async () => undefined);
		const clickNamed = async (label: string) => {
			const button = [...container.querySelectorAll("button")].find((node) =>
				node.textContent?.includes(label),
			);
			await act(async () => {
				button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
		};
		await clickNamed("Split");
		await clickNamed("Delete");
		expect(pixelsPerSecond(container)).toBeCloseTo(pps, 2);
		expect(timeline.style.width).toBe(`${pps * DURATION}px`);
		await clickNamed("Undo");
		expect(pixelsPerSecond(container)).toBeCloseTo(pps, 2);
		expect(zoomMode(container)).toBe("density");

		const video = container.querySelector("video");
		if (!video) throw new Error("missing video");
		await act(async () => {
			video.dispatchEvent(new Event("play"));
		});
		const inspected = 3200;
		port.scrollLeft = inspected;
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		video.currentTime = 1.2;
		await act(async () => {
			video.dispatchEvent(new Event("timeupdate"));
		});
		await flushFrames();
		expect(port.scrollLeft).toBe(inspected);
		expect(pixelsPerSecond(container)).toBeCloseTo(pps, 2);
	});

	it("keeps the original center when slider events batch before render", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		const port = scrollport(container);
		const center =
			(port.scrollLeft + viewportPx / 2) / pixelsPerSecond(container);
		const onChange = sliderOnChange(slider);
		const setSlider = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		await act(async () => {
			setSlider?.call(slider, "56");
			onChange({ target: slider });
			setSlider?.call(slider, "100");
			onChange({ target: slider });
		});
		await flushFrames();
		expect(pixelsPerSecond(container)).toBe(400);
		expect(port.scrollLeft).toBeCloseTo(center * 400 - viewportPx / 2, 0);
	});

	it("keeps the pointed source time across rapid modifier-wheel inputs", async () => {
		const { container } = await renderEditor();
		const port = scrollport(container);
		const pointerX = 250;
		const before = pixelsPerSecond(container);
		const pointed = (port.scrollLeft + pointerX) / before;
		dispatchModifierWheel(port, pointerX);
		dispatchModifierWheel(port, pointerX);
		await act(async () => undefined);
		await flushFrames();
		const after = pixelsPerSecond(container);
		expect(after).toBeCloseTo(before * 1.25 * 1.25, 2);
		expect(port.scrollLeft).toBeCloseTo(pointed * after - pointerX, 0);

		const movedPointer = 800;
		const rendered = pixelsPerSecond(container);
		const renderedScroll = port.scrollLeft;
		const movedTime = (renderedScroll + movedPointer) / rendered;
		dispatchModifierWheel(port, pointerX);
		dispatchModifierWheel(port, movedPointer);
		await act(async () => undefined);
		await flushFrames();
		const movedAfter = pixelsPerSecond(container);
		expect(movedAfter).toBeCloseTo(rendered * 1.25 * 1.25, 2);
		expect(port.scrollLeft).toBeCloseTo(
			movedTime * movedAfter - movedPointer,
			0,
		);
	});

	it("re-derives the anchor from the rendered scale after a manual pan", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "40");
		await flushFrames();
		const port = scrollport(container);
		port.scrollLeft = 2000;
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushFrames();
		const settled = pixelsPerSecond(container);
		const pointerX = 180;
		const panned = (port.scrollLeft + pointerX) / settled;
		dispatchModifierWheel(port, pointerX);
		await act(async () => undefined);
		await flushFrames();
		const afterPan = pixelsPerSecond(container);
		expect(afterPan).toBeCloseTo(settled * 1.25, 2);
		expect(port.scrollLeft).toBeCloseTo(panned * afterPan - pointerX, 0);

		const beforeBurst = pixelsPerSecond(container);
		const beforeScroll = port.scrollLeft;
		dispatchModifierWheel(port, pointerX);
		port.scrollLeft = beforeScroll + 100;
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		dispatchModifierWheel(port, pointerX);
		await act(async () => undefined);
		await flushFrames();
		const burst = pixelsPerSecond(container);
		const sourceTime = (beforeScroll + 100 + pointerX) / beforeBurst;
		expect(burst).toBeCloseTo(beforeBurst * 1.25 * 1.25, 2);
		expect(port.scrollLeft).toBeCloseTo(sourceTime * burst - pointerX, 0);
	});

	it("preserves the live pan center when expansion reaches its position before measure", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "100");
		await flushFrames();
		const port = scrollport(container);
		port.scrollLeft = 23000;
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushFrames();
		expect(port.clientWidth).toBe(1000);
		expect(port.scrollWidth).toBe(24000);
		expect(pixelsPerSecond(container)).toBe(400);

		port.scrollLeft = 22800;
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		const center = (port.scrollLeft + port.clientWidth / 2) / 400;
		expect(center).toBe(58.25);
		viewportPx = 1200;
		clampScrollToRenderedWidth(port);
		expect(port.scrollLeft).toBe(22800);
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(port.scrollLeft).toBe(22700);
		expect((port.scrollLeft + port.clientWidth / 2) / 400).toBe(center);
		expect(pixelsPerSecond(container)).toBe(400);
		expect(zoomMode(container)).toBe("density");
	});

	it.each(["before observer", "after observer"])(
		"recovers an actual expansion clamp with a new-width scroll event %s",
		async (scrollTiming) => {
			const { container } = await renderEditor();
			const slider = container.querySelector(
				"[data-zoom-level]",
			) as HTMLInputElement;
			await setInputValue(slider, "100");
			await flushFrames();
			const port = scrollport(container);
			port.scrollLeft = 23000;
			port.dispatchEvent(new Event("scroll", { bubbles: true }));
			await flushFrames();

			port.scrollLeft = 22850;
			port.dispatchEvent(new Event("scroll", { bubbles: true }));
			const center = (port.scrollLeft + port.clientWidth / 2) / 400;
			expect(center).toBe(58.375);
			viewportPx = 1200;
			clampScrollToRenderedWidth(port);
			expect(port.scrollLeft).toBe(22800);
			if (scrollTiming === "before observer") {
				port.dispatchEvent(new Event("scroll", { bubbles: true }));
			}
			for (const callback of ResizeObserverStub.callbacks) {
				callback([], {} as ResizeObserver);
			}
			if (scrollTiming === "after observer") {
				port.dispatchEvent(new Event("scroll", { bubbles: true }));
			}
			await flushFrames();
			expect(port.scrollLeft).toBe(22750);
			expect((port.scrollLeft + port.clientWidth / 2) / 400).toBe(center);
			expect(pixelsPerSecond(container)).toBe(400);
			expect(zoomMode(container)).toBe("density");
		},
	);

	it("does not suspend playback follow for resize-clamped or expected scroll events", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "100");
		await flushFrames();
		const port = scrollport(container);
		const video = container.querySelector("video");
		if (!video) throw new Error("missing video");
		video.currentTime = 58.375;
		await act(async () => {
			video.dispatchEvent(new Event("timeupdate"));
		});
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flushFrames();
		expect(port.scrollLeft).toBe(22850);
		await act(async () => {
			video.dispatchEvent(new Event("play"));
		});

		viewportPx = 1200;
		clampScrollToRenderedWidth(port);
		expect(port.scrollLeft).toBe(22800);
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(port.scrollLeft).toBe(22750);
		port.dispatchEvent(new Event("scroll", { bubbles: true }));
		const nextSourceTime = 40;
		video.currentTime = nextSourceTime;
		await act(async () => {
			video.dispatchEvent(new Event("timeupdate"));
		});
		expect(video.currentTime).toBe(nextSourceTime);
		await flushFrames();
		expect(port.scrollLeft).toBe(nextSourceTime * 400 - viewportPx / 2);
		expect(pixelsPerSecond(container)).toBe(400);
	});

	it("keeps the right-edge center when density width is absolute pixels", async () => {
		const { container } = await renderEditor();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "100");
		await flushFrames();
		const port = scrollport(container);
		const timeline = container.querySelector(
			"[data-editor-timeline]",
		) as HTMLElement;
		port.scrollLeft = 23000;
		expect(pixelsPerSecond(container)).toBe(400);
		expect(timeline.style.width).toBe("24000px");
		const center = (port.scrollLeft + viewportPx / 2) / 400;
		expect(center).toBeCloseTo(58.75, 2);

		viewportPx = 800;
		clampScrollToRenderedWidth(port);
		expect(timelineWidth(timeline)).toBe(24000);
		expect(port.scrollLeft).toBe(23000);
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(timeline.style.width).toBe("24000px");
		expect(pixelsPerSecond(container)).toBe(400);
		expect(zoomMode(container)).toBe("density");
		expect(port.scrollLeft).toBeCloseTo(23100, 0);
		expect((port.scrollLeft + viewportPx / 2) / 400).toBeCloseTo(58.75, 2);

		viewportPx = 1200;
		clampScrollToRenderedWidth(port);
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(timeline.style.width).toBe("24000px");
		expect(pixelsPerSecond(container)).toBe(400);
		expect(port.scrollLeft).toBeCloseTo(22800, 0);
	});

	it("keeps the left edge and fit width across resize", async () => {
		const { container } = await renderEditor();
		const fitTimeline = container.querySelector(
			"[data-editor-timeline]",
		) as HTMLElement;
		expect(zoomMode(container)).toBe("fit");
		expect(fitTimeline.style.width).toBe("100%");
		viewportPx = 640;
		clampScrollToRenderedWidth(scrollport(container));
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(zoomMode(container)).toBe("fit");
		expect(fitTimeline.style.width).toBe("100%");

		viewportPx = 1000;
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		const slider = container.querySelector(
			"[data-zoom-level]",
		) as HTMLInputElement;
		await setInputValue(slider, "100");
		await flushFrames();
		const port = scrollport(container);
		const timeline = container.querySelector(
			"[data-editor-timeline]",
		) as HTMLElement;
		port.scrollLeft = 0;
		viewportPx = 800;
		clampScrollToRenderedWidth(port);
		for (const callback of ResizeObserverStub.callbacks) {
			callback([], {} as ResizeObserver);
		}
		await flushFrames();
		expect(timeline.style.width).toBe("24000px");
		expect(pixelsPerSecond(container)).toBe(400);
		expect(port.scrollLeft).toBeCloseTo(100, 0);
		expect((port.scrollLeft + viewportPx / 2) / 400).toBeCloseTo(1.25, 2);
	});
});
