// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
	chapterLaneLayout,
	EditorChapterLane,
	EditorHoverGhost,
	EditorPlayhead,
	EditorTimelineRuler,
	EditorWaveformCanvas,
	EditorWaveformToolbar,
	nextWaveformRetryMs,
	rulerTicks,
	shouldResetWaveformFetch,
	visibleSourceWindow,
} from "@/app/s/[videoId]/edit/EditorWaveform";

describe("waveform retry and identity reset", () => {
	it("retries a missing object at 8s and 30s, then stops", () => {
		expect(nextWaveformRetryMs(0)).toBe(8_000);
		expect(nextWaveformRetryMs(1)).toBe(30_000);
		expect(nextWaveformRetryMs(2)).toBeNull();
	});

	it("resets a fetch when the video or source sha changes", () => {
		expect(
			shouldResetWaveformFetch({
				videoId: "video-ready-01",
				sourceSha256: "ab",
				previousVideoId: "video-ready-01",
				previousSha256: "ab",
			}),
		).toBe(false);
		expect(
			shouldResetWaveformFetch({
				videoId: "video-ready-01",
				sourceSha256: "cd",
				previousVideoId: "video-ready-01",
				previousSha256: "ab",
			}),
		).toBe(true);
	});
});

describe("chapter lane geometry", () => {
	it("keeps source times and truncates before the next marker", () => {
		const laid = chapterLaneLayout({
			duration: 100,
			chapters: [
				{ title: "Opening remarks that run long", start: 10 },
				{ title: "Next", start: 25 },
			],
		});
		expect(laid[0]?.start).toBe(10);
		expect(laid[0]?.left).toBe(10);
		expect(laid[0]?.maxWidth).toBe(15);
		expect(laid[1]?.maxWidth).toBe(75);
	});
});

describe("waveform toolbar", () => {
	let root: Root;
	let container: HTMLDivElement;

	afterEach(() => {
		root.unmount();
		container.remove();
	});

	it("exposes hide, zoom, and whole-video controls above the timeline hooks", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(EditorWaveformToolbar, {
					hidden: false,
					onToggle: () => undefined,
					zoom: 1,
					minZoom: 1,
					maxZoom: 12,
					onZoom: () => undefined,
					onWholeVideo: () => undefined,
				}),
			);
		});
		expect(container.querySelector("[data-waveform-toolbar]")).not.toBeNull();
		expect(
			container
				.querySelector("[data-hide-waveform]")
				?.getAttribute("aria-pressed"),
		).toBe("true");
		expect(container.querySelector("[aria-label='Zoom out']")).not.toBeNull();
		expect(container.querySelector("[aria-label='Zoom in']")).not.toBeNull();
		expect(
			container.querySelector("[data-whole-video]")?.textContent,
		).toContain("Whole video");
	});

	it("renders a truncating chapter title at the source position", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(EditorChapterLane, {
					duration: 100,
					chapters: [
						{ title: "Opening remarks that run long", start: 10 },
						{ title: "Next", start: 25 },
					],
				}),
			);
		});
		const title = container.querySelector("[data-chapter-title]");
		expect(title?.getAttribute("data-source-start")).toBe("10");
		expect(title?.getAttribute("style")).toContain("max-width: 15%");
		expect(title?.querySelector(".truncate")).not.toBeNull();
	});
});

describe("source-time ruler and playhead geometry", () => {
	let root: Root;
	let container: HTMLDivElement;

	afterEach(() => {
		root?.unmount();
		container?.remove();
	});

	it("places major ticks across the visible source window", async () => {
		const sourceWindow = visibleSourceWindow({
			sourceDuration: 100,
			scrollLeft: 800,
			viewportWidth: 800,
			zoom: 4,
		});
		expect(sourceWindow.start).toBe(25);
		expect(sourceWindow.end).toBe(50);
		const ticks = rulerTicks({
			sourceDuration: 100,
			scrollLeft: 800,
			viewportWidth: 800,
			zoom: 4,
		});
		expect(ticks.length).toBeGreaterThan(1);
		expect(ticks[0]?.time).toBeGreaterThanOrEqual(25);
		expect(ticks.at(-1)?.time).toBeLessThanOrEqual(50);
		expect(ticks.some((tick) => tick.label.length > 0 && tick.major)).toBe(
			true,
		);
		expect(ticks.find((tick) => tick.time === 25)?.leftPercent).toBe(25);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(EditorTimelineRuler, {
					duration: 100,
					scrollLeft: 800,
					viewportWidth: 800,
					zoom: 4,
				}),
			);
		});
		const tick = container.querySelector(
			"[data-ruler-tick][data-source-time='25']",
		);
		expect(tick?.getAttribute("style")).toContain("left: 25%");
		expect(tick?.textContent).toContain("0:25");
		expect(
			container.querySelector("[data-timeline-ruler]")?.className,
		).toContain("h-[22px]");
	});

	it("anchors the triangle in the ruler and the line in the waveform lane", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(createElement(EditorPlayhead, { label: "00:10.00" }));
		});
		const triangle = container.querySelector("[data-playhead-triangle]");
		const line = container.querySelector("[data-playhead-line]");
		expect(triangle).not.toBeNull();
		expect(
			Number.parseFloat(triangle?.getAttribute("data-top-px") ?? ""),
		).toBeLessThan(22);
		expect(line?.getAttribute("data-top-px")).toBe("40");
		expect(line?.getAttribute("data-height-px")).toBe("64");
	});

	it("keeps the hover ghost on the waveform line coordinates", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(createElement(EditorHoverGhost, { fraction: 0.25 }));
		});
		const ghost = container.querySelector("[data-hover-ghost]");
		expect(ghost?.getAttribute("style")).toContain("left: 25%");
		expect(ghost?.getAttribute("data-top-px")).toBe("40");
		expect(ghost?.getAttribute("data-height-px")).toBe("64");
	});
});

describe("viewport waveform canvas", () => {
	let root: Root;
	let container: HTMLDivElement;
	const draws: number[][] = [];

	afterEach(() => {
		root?.unmount();
		container?.remove();
		draws.length = 0;
	});

	it("paints only the visible window into a viewport-sized lane canvas", async () => {
		HTMLCanvasElement.prototype.getContext = (() => ({
			setTransform() {},
			clearRect() {},
			fillRect(x: number, y: number, w: number, h: number) {
				draws.push([x, y, w, h]);
			},
			beginPath() {},
			moveTo() {},
			lineTo(x: number, y: number) {
				draws.push([x, y, 0, 0]);
			},
			closePath() {},
			fill() {},
			save() {},
			restore() {},
			rect() {},
			clip() {},
			fillStyle: "",
		})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
		Object.defineProperty(window, "devicePixelRatio", {
			configurable: true,
			value: 2,
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const pairs = Array.from({ length: 100 }, () => ({ min: -40, max: 40 }));
		await act(async () => {
			root.render(
				createElement(
					"div",
					{ "data-editor-timeline": "" },
					createElement("div", {
						"data-timeline-ruler": "",
						style: { height: "22px" },
					}),
					createElement("div", {
						"data-chapter-lane": "",
						style: { height: "18px" },
					}),
					createElement(
						"div",
						{
							"data-waveform-lane": "",
							style: {
								position: "relative",
								height: "64px",
								width: "320px",
								overflow: "hidden",
							},
						},
						createElement(EditorWaveformCanvas, {
							pairs,
							noAudio: false,
							duration: 1,
							deleted: [],
							hidden: false,
							scrollLeft: 40,
							viewportWidth: 80,
							zoom: 4,
						}),
					),
				),
			);
		});
		const canvas = container.querySelector("canvas");
		const lane = container.querySelector("[data-waveform-lane]");
		expect(canvas?.parentElement).toBe(lane);
		expect(
			container.querySelector("[data-timeline-ruler]")?.contains(canvas),
		).toBe(false);
		expect(
			container.querySelector("[data-chapter-lane]")?.contains(canvas),
		).toBe(false);
		expect(canvas?.style.width).toBe("80px");
		expect(canvas?.style.height).toBe("64px");
		expect(canvas?.width).toBe(160);
		expect(canvas?.style.left).toBe("40px");
		expect(draws.length).toBeGreaterThan(0);
		expect(
			draws.every(
				(draw) => draw[0] !== undefined && draw[0] >= 0 && draw[0] <= 80,
			),
		).toBe(true);
	});
});
