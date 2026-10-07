// @vitest-environment jsdom

import { act, type ComponentProps, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	EditorWaveformCanvas,
	TIMELINE_WAVEFORM_PX,
} from "@/app/s/[videoId]/edit/EditorWaveform";
import type { PeakPair } from "@/lib/waveform-peaks";

const DRAWABLE = TIMELINE_WAVEFORM_PX - 8;

type Paint = { x: number; y: number; w: number; h: number; fill: string };

function gammaBar(magnitude: number) {
	return Math.max(1, (magnitude / 127) ** 3 * DRAWABLE);
}

async function renderWaveform(
	pairs: readonly PeakPair[] | null,
	deleted: readonly { start: number; end: number }[] = [],
	options: Partial<ComponentProps<typeof EditorWaveformCanvas>> = {},
) {
	const paints: Paint[] = [];
	const transforms: number[][] = [];
	const clears: number[][] = [];
	const context = {
		fillStyle: "",
		setTransform(...args: number[]) {
			transforms.push(args);
		},
		clearRect(...args: number[]) {
			clears.push(args);
		},
		fillRect(x: number, y: number, w: number, h: number) {
			paints.push({ x, y, w, h, fill: context.fillStyle });
		},
	};
	HTMLCanvasElement.prototype.getContext = (() =>
		context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const duration = (pairs?.length ?? 3) / 100;
	await act(async () => {
		root.render(
			createElement(EditorWaveformCanvas, {
				pairs,
				noAudio: false,
				duration,
				deleted,
				hidden: false,
				scrollLeft: 0,
				viewportWidth: pairs?.length || 3,
				zoom: 1,
				...options,
			}),
		);
	});
	const canvas = container.querySelector("canvas");
	act(() => {
		root.unmount();
	});
	return { paints, canvas, transforms, clears };
}

async function paintPairs(
	pairs: readonly PeakPair[],
	deleted: readonly { start: number; end: number }[] = [],
	options: Partial<ComponentProps<typeof EditorWaveformCanvas>> = {},
) {
	return (await renderWaveform(pairs, deleted, options)).paints;
}

function expectGeometry(
	paints: Paint[],
	segments: readonly (readonly [number, number, number, string])[],
) {
	expect(paints).toHaveLength(segments.length);
	for (const [index, [x, w, magnitude, fill]] of segments.entries()) {
		const paint = paints[index];
		if (!paint) throw new Error(`Missing paint at segment ${index}`);
		expect(paint.x).toBeCloseTo(x, 12);
		expect(paint.w).toBeCloseTo(w, 12);
		expect(paint.h).toBeCloseTo(gammaBar(magnitude), 12);
		expect(paint.y).toBeCloseTo(TIMELINE_WAVEFORM_PX / 2 - paint.h / 2, 12);
		expect(paint.fill).toBe(fill);
		expect(paint.w).toBeGreaterThan(0);
		if (index > 0) {
			const previous = paints[index - 1];
			if (!previous) throw new Error(`Missing preceding segment ${index}`);
			expect(paint.x).toBeCloseTo(previous.x + previous.w, 12);
		}
	}
}

function columnPairs(pairs: readonly PeakPair[]) {
	return pairs.flatMap((pair) =>
		Array.from({ length: 100 }, () => ({ ...pair })),
	);
}

const originalDpr = window.devicePixelRatio;
const originalGetContext = HTMLCanvasElement.prototype.getContext;

describe("editor waveform paint contrast", () => {
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

	it("paints contiguous gamma 3 columns and keeps a transient at its source column", async () => {
		const quiet = await paintPairs([
			{ min: -70, max: 70 },
			{ min: -70, max: 70 },
			{ min: -70, max: 70 },
		]);
		const loud = await paintPairs([
			{ min: -120, max: 120 },
			{ min: -120, max: 120 },
			{ min: -120, max: 120 },
		]);
		const quietBar = quiet.find((paint) => paint.x === 0);
		const loudBar = loud.find((paint) => paint.x === 0);
		expect(quietBar?.w).toBe(1);
		expect(loudBar?.w).toBe(1);
		expect(quietBar?.h).toBeCloseTo(gammaBar(70), 2);
		expect(loudBar?.h).toBeCloseTo(gammaBar(120), 2);
		expect((loudBar?.h ?? 0) / (quietBar?.h ?? 1)).toBeGreaterThan(4);
		expect(quiet.map((paint) => paint.x)).toEqual([0, 1, 2]);

		const spike = await paintPairs([
			{ min: -10, max: 10 },
			{ min: -10, max: 10 },
			{ min: -127, max: 127 },
			{ min: -10, max: 10 },
			{ min: -10, max: 10 },
			{ min: -10, max: 10 },
		]);
		expect(spike.find((paint) => paint.x === 0)?.h).toBeCloseTo(
			gammaBar(10),
			2,
		);
		expect(spike.find((paint) => paint.x === 2)?.h).toBe(gammaBar(127));
		expect(spike.find((paint) => paint.x === 3)?.h).toBe(gammaBar(10));

		const zero = await paintPairs([
			{ min: 0, max: 0 },
			{ min: 0, max: 0 },
			{ min: 0, max: 0 },
		]);
		expect(zero.find((paint) => paint.x === 0)?.h).toBe(1);

		const source: PeakPair[] = [
			{ min: -80, max: 80 },
			{ min: -80, max: 80 },
			{ min: -80, max: 80 },
		];
		const before = JSON.stringify(source);
		const deleted = await paintPairs(source, [{ start: 0, end: 1 }]);
		expect(JSON.stringify(source)).toBe(before);
		expect(deleted.find((paint) => paint.x === 0)?.fill).toBe("#c4c4c4");
		expect(deleted.find((paint) => paint.x === 0)?.w).toBe(1);
	});

	it("does not gray kept bar pixels for a deleted gap-column transient", async () => {
		const paints = await paintPairs(
			[
				{ min: -10, max: 10 },
				{ min: -10, max: 10 },
				{ min: -127, max: 127 },
			],
			[{ start: 0.02, end: 0.03 }],
		);
		expect(paints.find((paint) => paint.x === 0)?.fill).toBe("#0090ff");
		expect(paints.find((paint) => paint.x === 0)?.h).toBe(gammaBar(10));
		expect(paints.find((paint) => paint.x === 2)?.fill).toBe("#c4c4c4");
		expect(paints.find((paint) => paint.x === 2)?.h).toBe(gammaBar(127));
	});

	it("does not blue deleted bar pixels for a kept gap-column transient", async () => {
		const paints = await paintPairs(
			[
				{ min: -10, max: 10 },
				{ min: -10, max: 10 },
				{ min: -127, max: 127 },
			],
			[{ start: 0, end: 0.02 }],
		);
		expect(paints.find((paint) => paint.x === 0)?.fill).toBe("#c4c4c4");
		expect(paints.find((paint) => paint.x === 0)?.h).toBe(gammaBar(10));
		expect(paints.find((paint) => paint.x === 2)?.fill).toBe("#0090ff");
		expect(paints.find((paint) => paint.x === 2)?.h).toBe(gammaBar(127));
	});

	it("keeps integer cut boundaries independent of each column's amplitude", async () => {
		const keptThenDeleted = await paintPairs(
			[
				{ min: -10, max: 10 },
				{ min: -20, max: 20 },
				{ min: -127, max: 127 },
			],
			[{ start: 0.01, end: 0.03 }],
		);
		const keptPixel = keptThenDeleted.find((paint) => paint.x === 0);
		const deletedPixel = keptThenDeleted.find((paint) => paint.x === 1);
		expect(keptPixel?.fill).toBe("#0090ff");
		expect(keptPixel?.w).toBe(1);
		expect(deletedPixel?.fill).toBe("#c4c4c4");
		expect(deletedPixel?.w).toBe(1);
		expect(keptPixel?.h).toBeCloseTo(gammaBar(10), 2);
		expect(deletedPixel?.h).toBeCloseTo(gammaBar(20), 2);
		expect(keptThenDeleted.find((paint) => paint.x === 2)?.h).toBe(
			gammaBar(127),
		);

		const deletedThenKept = await paintPairs(
			[
				{ min: -20, max: 20 },
				{ min: -10, max: 10 },
				{ min: -127, max: 127 },
			],
			[{ start: 0, end: 0.01 }],
		);
		expect(deletedThenKept.find((paint) => paint.x === 0)?.fill).toBe(
			"#c4c4c4",
		);
		expect(deletedThenKept.find((paint) => paint.x === 0)?.w).toBe(1);
		expect(deletedThenKept.find((paint) => paint.x === 1)?.fill).toBe(
			"#0090ff",
		);
		expect(deletedThenKept.find((paint) => paint.x === 1)?.w).toBe(1);
		expect(deletedThenKept.find((paint) => paint.x === 2)?.fill).toBe(
			"#0090ff",
		);
	});

	it("keeps homogeneous gamma and per-column transient height without transferring tint", async () => {
		const kept = await paintPairs([
			{ min: -10, max: 10 },
			{ min: -10, max: 10 },
			{ min: -127, max: 127 },
		]);
		const keptBar = kept.find((paint) => paint.x === 0);
		expect(keptBar?.fill).toBe("#0090ff");
		expect(keptBar?.w).toBe(1);
		expect(keptBar?.h).toBeCloseTo(gammaBar(10), 2);
		expect(kept.find((paint) => paint.x === 2)?.h).toBeGreaterThan(
			gammaBar(10) + 1,
		);

		const deleted = await paintPairs(
			[
				{ min: -10, max: 10 },
				{ min: -10, max: 10 },
				{ min: -127, max: 127 },
			],
			[{ start: 0, end: 0.03 }],
		);
		const deletedBar = deleted.find((paint) => paint.x === 0);
		expect(deletedBar?.fill).toBe("#c4c4c4");
		expect(deletedBar?.w).toBe(1);
		expect(deletedBar?.h).toBeCloseTo(gammaBar(10), 2);
		expect(deleted.find((paint) => paint.x === 2)?.h).toBe(gammaBar(127));

		const even = await paintPairs([
			{ min: -80, max: 80 },
			{ min: -80, max: 80 },
			{ min: -80, max: 80 },
		]);
		expect(even.find((paint) => paint.x === 0)?.h).toBeCloseTo(gammaBar(80), 2);
		expect(even.find((paint) => paint.x === 0)?.w).toBe(1);
	});

	it.each([0, 1, 2])(
		"keeps a spike at former pitch position %i without pooling",
		async (position) => {
			const pairs = Array.from({ length: 3 }, (_, index) => ({
				min: index === position ? -127 : -10,
				max: index === position ? 127 : 10,
			}));
			expectGeometry(
				await paintPairs(columnPairs(pairs), [], { viewportWidth: 3 }),
				pairs.map((_, index) => [
					index,
					1,
					index === position ? 127 : 10,
					"#0090ff",
				]),
			);
		},
	);

	it("fills varying asymmetric extrema and the silent baseline without flattening", async () => {
		expectGeometry(
			await paintPairs(
				columnPairs([
					{ min: -100, max: 20 },
					{ min: -10, max: 120 },
					{ min: 0, max: 0 },
				]),
				[],
				{ viewportWidth: 3 },
			),
			[
				[0, 1, 100, "#0090ff"],
				[1, 1, 120, "#0090ff"],
				[2, 1, 0, "#0090ff"],
			],
		);
	});

	it("retains downsampled extrema in their fit columns", async () => {
		expectGeometry(
			await paintPairs(
				[
					{ min: -10, max: 10 },
					{ min: -100, max: 20 },
					{ min: -10, max: 120 },
					{ min: -10, max: 10 },
					{ min: 0, max: 0 },
					{ min: 0, max: 0 },
				],
				[],
				{ viewportWidth: 3 },
			),
			[
				[0, 1, 100, "#0090ff"],
				[1, 1, 120, "#0090ff"],
				[2, 1, 0, "#0090ff"],
			],
		);
	});

	it("splits fractional cuts without midpoint tint or rounding", async () => {
		expectGeometry(
			await paintPairs(
				columnPairs([
					{ min: -70, max: 70 },
					{ min: -120, max: 120 },
					{ min: 0, max: 0 },
				]),
				[{ start: 0.25, end: 1.75 }],
				{ viewportWidth: 3 },
			),
			[
				[0, 0.25, 70, "#0090ff"],
				[0.25, 0.75, 70, "#c4c4c4"],
				[1, 0.75, 120, "#c4c4c4"],
				[1.75, 0.25, 120, "#0090ff"],
				[2, 1, 0, "#0090ff"],
			],
		);
	});

	it("paints blue grey blue within one column with identical envelope height", async () => {
		expectGeometry(
			await paintPairs(
				columnPairs([
					{ min: -80, max: 80 },
					{ min: -10, max: 10 },
					{ min: -127, max: 127 },
				]),
				[{ start: 0.25, end: 0.75 }],
				{ viewportWidth: 3 },
			),
			[
				[0, 0.25, 80, "#0090ff"],
				[0.25, 0.5, 80, "#c4c4c4"],
				[0.75, 0.25, 80, "#0090ff"],
				[1, 1, 10, "#0090ff"],
				[2, 1, 127, "#0090ff"],
			],
		);
	});

	it("clips sorts and unions overlapping or touching cuts without mutating inputs", async () => {
		const pairs = Object.freeze(
			columnPairs([
				{ min: -70, max: 70 },
				{ min: -120, max: 120 },
				{ min: 0, max: 0 },
			]).map((pair) => Object.freeze(pair)),
		);
		const deleted = Object.freeze([
			Object.freeze({ start: 2.5, end: 10 }),
			Object.freeze({ start: 0.5, end: 1.25 }),
			Object.freeze({ start: -1, end: 0.75 }),
			Object.freeze({ start: 1.25, end: 1.75 }),
			Object.freeze({ start: 10, end: 20 }),
			Object.freeze({ start: -2, end: -1 }),
			Object.freeze({ start: 2, end: 2 }),
			Object.freeze({ start: 2.2, end: 2.1 }),
		]);
		const before = JSON.stringify({ pairs, deleted });
		expectGeometry(await paintPairs(pairs, deleted, { viewportWidth: 3 }), [
			[0, 1, 70, "#c4c4c4"],
			[1, 0.75, 120, "#c4c4c4"],
			[1.75, 0.25, 120, "#0090ff"],
			[2, 0.5, 0, "#0090ff"],
			[2.5, 0.5, 0, "#c4c4c4"],
		]);
		expect(JSON.stringify({ pairs, deleted })).toBe(before);
	});

	it("uses the same scrolled zoom window for amplitude and fractional cut colors", async () => {
		const pairs = columnPairs(
			[10, 20, 70, 120, 0, 100, 30, 40].map((magnitude) => ({
				min: -magnitude,
				max: magnitude,
			})),
		);
		expectGeometry(
			await paintPairs(
				pairs,
				[
					{ start: 0, end: 2.25 },
					{ start: 2.75, end: 3.25 },
					{ start: 5.75, end: 10 },
				],
				{ viewportWidth: 4, zoom: 2, scrollLeft: 2 },
			),
			[
				[0, 0.25, 70, "#c4c4c4"],
				[0.25, 0.5, 70, "#0090ff"],
				[0.75, 0.25, 70, "#c4c4c4"],
				[1, 0.25, 120, "#c4c4c4"],
				[1.25, 0.75, 120, "#0090ff"],
				[2, 1, 0, "#0090ff"],
				[3, 0.75, 100, "#0090ff"],
				[3.75, 0.25, 100, "#c4c4c4"],
			],
		);
	});

	it.each(["noAudio", "null", "empty"])(
		"preserves flat grey %s fallback",
		async (kind) => {
			const result = await renderWaveform(
				kind === "null"
					? null
					: kind === "empty"
						? []
						: [{ min: -127, max: 127 }],
				[{ start: 0, end: 1 }],
				{ noAudio: kind === "noAudio", viewportWidth: 3 },
			);
			expect(result.paints).toEqual([
				{
					x: 0,
					y: TIMELINE_WAVEFORM_PX / 2,
					w: 3,
					h: 1,
					fill: "#8d8d8d",
				},
			]);
		},
	);

	it("preserves hidden behavior without allocating or painting a canvas", async () => {
		const result = await renderWaveform([{ min: -127, max: 127 }], [], {
			hidden: true,
		});
		expect(result.canvas).toBeNull();
		expect(result.paints).toEqual([]);
		expect(result.transforms).toEqual([]);
		expect(result.clears).toEqual([]);
	});

	it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
		"guards invalid or zero source duration %s",
		async (duration) => {
			const result = await renderWaveform(
				[{ min: -127, max: 127 }],
				[{ start: 0, end: 1 }],
				{ duration },
			);
			expect(result.paints).toEqual([]);
		},
	);

	it("guards a zero source span at the timeline end", async () => {
		const result = await renderWaveform(
			[{ min: -127, max: 127 }],
			[{ start: 0, end: 1 }],
			{ viewportWidth: 3, zoom: 2, scrollLeft: 6 },
		);
		expect(result.paints).toEqual([]);
	});

	it.each([1, 2, 3, 4])(
		"preserves viewport allocation and source geometry at DPR %i",
		async (dpr) => {
			Object.defineProperty(window, "devicePixelRatio", {
				configurable: true,
				value: dpr,
			});
			const result = await renderWaveform(
				[
					{ min: 0, max: 0 },
					{ min: 0, max: 0 },
					{ min: 0, max: 0 },
					{ min: -70, max: 70 },
					{ min: -120, max: 120 },
					{ min: 0, max: 0 },
				],
				[{ start: 0.0325, end: 0.0375 }],
				{ viewportWidth: 3.9, scrollLeft: 3, zoom: 2, duration: 0.06 },
			);
			const capped = Math.min(3, dpr);
			expect(result.canvas?.width).toBe(3 * capped);
			expect(result.canvas?.height).toBe(TIMELINE_WAVEFORM_PX * capped);
			expect(result.canvas?.style.width).toBe("3px");
			expect(result.canvas?.style.height).toBe(`${TIMELINE_WAVEFORM_PX}px`);
			expect(result.canvas?.style.left).toBe("3px");
			expect(result.canvas?.className).toBe(
				"pointer-events-none absolute top-0 z-[3]",
			);
			expect(result.transforms).toEqual([[capped, 0, 0, capped, 0, 0]]);
			expect(result.clears).toEqual([[0, 0, 3, TIMELINE_WAVEFORM_PX]]);
			expectGeometry(result.paints, [
				[0, 0.25, 70, "#0090ff"],
				[0.25, 0.5, 70, "#c4c4c4"],
				[0.75, 0.25, 70, "#0090ff"],
				[1, 1, 120, "#0090ff"],
				[2, 1, 0, "#0090ff"],
			]);
		},
	);
});
