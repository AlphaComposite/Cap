// @vitest-environment jsdom

import { act, type ComponentProps, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	EditorWaveformCanvas,
	formatRulerLabel,
	keptColumnRanges,
	TIMELINE_WAVEFORM_PX,
	WAVEFORM_GAMMA,
	WAVEFORM_KEPT_COLOR,
	WAVEFORM_REMOVED_COLOR,
	waveformEnvelope,
	waveformLevel,
} from "@/app/s/[videoId]/edit/EditorWaveform";
import type { PeakPair } from "@/lib/waveform-peaks";

type Fill = { color: string; clip: number[][]; points: [number, number][] };

async function renderWaveform(
	pairs: readonly PeakPair[] | null,
	deleted: readonly { start: number; end: number }[] = [],
	options: Partial<ComponentProps<typeof EditorWaveformCanvas>> = {},
) {
	const fills: Fill[] = [];
	const rects: number[][] = [];
	const transforms: number[][] = [];
	const clears: number[][] = [];
	let points: [number, number][] = [];
	let pendingClip: number[][] = [];
	let clip: number[][] = [];
	const context = {
		fillStyle: "",
		setTransform: (...args: number[]) => transforms.push(args),
		clearRect: (...args: number[]) => clears.push(args),
		fillRect: (...args: number[]) => rects.push(args),
		beginPath: () => {
			points = [];
			pendingClip = [];
		},
		moveTo: (x: number, y: number) => points.push([x, y]),
		lineTo: (x: number, y: number) => points.push([x, y]),
		closePath: () => {},
		rect: (...args: number[]) => pendingClip.push(args),
		clip: () => {
			clip = pendingClip;
		},
		save: () => {},
		restore: () => {
			clip = [];
		},
		fill: () => fills.push({ color: context.fillStyle, clip, points }),
	};
	HTMLCanvasElement.prototype.getContext = (() =>
		context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			createElement(EditorWaveformCanvas, {
				pairs,
				noAudio: false,
				duration: (pairs?.length ?? 3) / 100,
				deleted,
				hidden: false,
				scrollLeft: 0,
				viewportWidth: 200,
				zoom: 1,
				...options,
			}),
		);
	});
	const canvas = container.querySelector("canvas");
	act(() => root.unmount());
	return { fills, rects, canvas, transforms, clears };
}

/** Top-edge heights (mid - y) of the outline, in column order. */
function topHeights(fill: Fill) {
	const mid = TIMELINE_WAVEFORM_PX / 2;
	return fill.points
		.filter(([x, y]) => y <= mid && x > 0 && x % 1 === 0.5)
		.slice(0, Math.floor(fill.points.length / 2))
		.map(([, y]) => mid - y);
}

const speech = (seconds: number, loud: number) =>
	Array.from({ length: seconds * 100 }, (_, i) => {
		// 2 syllables per second with pauses between them
		const on = Math.sin((i / 100) * Math.PI * 4) > 0;
		const v = on ? loud : 2;
		return { min: -v, max: v };
	});

const originalDpr = window.devicePixelRatio;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

describe("editor waveform blob painter", () => {
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
	});
	afterEach(() => {
		document.body.replaceChildren();
		HTMLCanvasElement.prototype.getContext = originalGetContext;
		Object.defineProperty(window, "devicePixelRatio", {
			configurable: true,
			value: originalDpr,
		});
	});

	it("paints one mirrored outline path, not per-column bars", async () => {
		const { fills, rects } = await renderWaveform(speech(2, 100));
		expect(rects).toEqual([]);
		expect(fills).toHaveLength(2);
		const mid = TIMELINE_WAVEFORM_PX / 2;
		for (const fill of fills) {
			const half = (fill.points.length - 2) / 2;
			const tops = fill.points.slice(1, 1 + half);
			const bottoms = fill.points.slice(2 + half).reverse();
			expect(tops).toHaveLength(bottoms.length);
			tops.forEach(([x, y], i) => {
				expect(bottoms[i]?.[0]).toBe(x);
				expect((bottoms[i]?.[1] ?? 0) - mid).toBeCloseTo(mid - y, 9);
			});
		}
	});

	it("paints removed audio grey everywhere and kept audio lavender clipped to kept ranges", async () => {
		const { fills } = await renderWaveform(speech(2, 100), [
			{ start: 0.5, end: 1 },
		]);
		expect(fills.map((fill) => fill.color)).toEqual([
			WAVEFORM_REMOVED_COLOR,
			WAVEFORM_KEPT_COLOR,
		]);
		expect(fills[0]?.clip).toEqual([]);
		expect(fills[1]?.clip).toEqual([
			[0, 0, 50, TIMELINE_WAVEFORM_PX],
			[100, 0, 100, TIMELINE_WAVEFORM_PX],
		]);
	});

	it("skips the kept layer when the whole window is removed", async () => {
		const { fills } = await renderWaveform(speech(1, 100), [
			{ start: 0, end: 1 },
		]);
		expect(fills.map((fill) => fill.color)).toEqual([WAVEFORM_REMOVED_COLOR]);
	});

	it("keeps syllables as separate rounded shapes with dips between them", async () => {
		const { fills } = await renderWaveform(speech(2, 100), [], {
			viewportWidth: 800,
		});
		const tops = topHeights(fills[0] as Fill);
		const peak = Math.max(...tops);
		const dips = tops.filter(
			(h, i) =>
				i > 0 &&
				i < tops.length - 1 &&
				h < (tops[i - 1] ?? 0) &&
				h <= (tops[i + 1] ?? 0) &&
				h < peak * 0.5,
		);
		expect(dips.length).toBeGreaterThanOrEqual(3);
		// smoothing: no column-to-column jump bigger than a third of the peak
		for (let i = 1; i < tops.length; i += 1) {
			expect(Math.abs((tops[i] ?? 0) - (tops[i - 1] ?? 0))).toBeLessThan(
				peak / 3,
			);
		}
	});

	it("levels quiet and loud recordings to similar heights", async () => {
		const quiet = topHeights(
			(await renderWaveform(speech(2, 40))).fills[0] as Fill,
		);
		const loud = topHeights(
			(await renderWaveform(speech(2, 120))).fills[0] as Fill,
		);
		const max = (v: number[]) => Math.max(...v);
		expect(max(quiet) / max(loud)).toBeGreaterThan(0.85);
		expect(max(loud)).toBeLessThanOrEqual(TIMELINE_WAVEFORM_PX / 2 - 5 + 1e-9);
	});

	it("draws a flat baseline for silence and no-audio", async () => {
		const silent = await renderWaveform(
			Array.from({ length: 100 }, () => ({ min: 0, max: 0 })),
		);
		expect(Math.max(...topHeights(silent.fills[0] as Fill))).toBeCloseTo(
			0.75,
			9,
		);
		const none = await renderWaveform(null);
		expect(none.fills).toEqual([]);
		expect(none.rects).toEqual([[0, TIMELINE_WAVEFORM_PX / 2, 200, 1]]);
	});

	it("preserves hidden behavior without allocating or painting a canvas", async () => {
		const result = await renderWaveform(speech(1, 100), [], { hidden: true });
		expect(result.canvas).toBeNull();
		expect(result.fills).toEqual([]);
		expect(result.transforms).toEqual([]);
	});

	it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
		"guards invalid source duration %s",
		async (duration) => {
			const result = await renderWaveform(speech(1, 100), [], { duration });
			expect(result.fills).toEqual([]);
		},
	);

	it.each([1, 2, 3, 4])("keeps viewport allocation at DPR %i", async (dpr) => {
		Object.defineProperty(window, "devicePixelRatio", {
			configurable: true,
			value: dpr,
		});
		const result = await renderWaveform(speech(1, 100), [], {
			viewportWidth: 3.9,
			scrollLeft: 3,
			zoom: 2,
		});
		const capped = Math.min(3, dpr);
		expect(result.canvas?.width).toBe(3 * capped);
		expect(result.canvas?.height).toBe(TIMELINE_WAVEFORM_PX * capped);
		expect(result.canvas?.style.left).toBe("3px");
		expect(result.transforms).toEqual([[capped, 0, 0, capped, 0, 0]]);
		expect(result.clears).toEqual([[0, 0, 3, TIMELINE_WAVEFORM_PX]]);
	});
});

describe("waveform helpers", () => {
	it("merges, sorts and clips removed ranges into kept column ranges", () => {
		const deleted = [
			{ start: 6, end: 8 },
			{ start: -1, end: 1 },
			{ start: 7, end: 9 },
			{ start: 3, end: 3 },
		];
		const copy = structuredClone(deleted);
		expect(
			keptColumnRanges({
				deleted,
				sourceWindow: { start: 0, end: 10 },
				width: 100,
			}),
		).toEqual([
			{ start: 10, end: 60 },
			{ start: 90, end: 100 },
		]);
		expect(deleted).toEqual(copy);
		expect(
			keptColumnRanges({
				deleted: [],
				sourceWindow: { start: 1, end: 1 },
				width: 100,
			}),
		).toEqual([]);
	});

	it("levels to the loud parts, ignoring a single spike", () => {
		const pairs = [...speech(5, 60), { min: -127, max: 127 }];
		const level = waveformLevel(pairs);
		expect(level).toBeCloseTo((60 / 127) ** WAVEFORM_GAMMA, 6);
		expect(waveformLevel([])).toBe(1);
		expect(
			waveformLevel(Array.from({ length: 10 }, () => ({ min: 0, max: 0 }))),
		).toBe(1);
	});

	it("envelope stays within 0..1", () => {
		const env = waveformEnvelope({
			amplitudes: [0, 1, 1, 0.2, 0],
			level: 0.1,
			pxPerSecond: 100,
		});
		expect(env.every((v) => v >= 0 && v <= 1)).toBe(true);
	});

	it("labels sub-second ruler steps with tenths", () => {
		expect(formatRulerLabel(389.5, 0.5)).toBe("6:29.5");
		expect(formatRulerLabel(390, 0.5)).toBe("6:30.0");
		expect(formatRulerLabel(389.6, 1)).toBe("6:30");
	});
});
