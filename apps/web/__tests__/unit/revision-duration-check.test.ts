import { describe, expect, it } from "vitest";
import { snappedDurationError } from "@/lib/revision-duration-check";

const TB = 15360;

const SCOUT = [
	{
		end: 6.122,
		lastPts: 6.108333,
		lastDur: 0.133333,
		total: 6.241667,
		ticks: 95872,
	},
	{
		end: 5.674,
		lastPts: 5.633333,
		lastDur: 0.141667,
		total: 5.775,
		ticks: 88704,
	},
	{
		end: 5.657,
		lastPts: 5.633333,
		lastDur: 0.141667,
		total: 5.775,
		ticks: 88704,
	},
	{
		end: 5.641,
		lastPts: 5.633333,
		lastDur: 0.141667,
		total: 5.775,
		ticks: 88704,
	},
	{
		end: 11.055,
		lastPts: 11.016667,
		lastDur: 0.091667,
		total: 11.108333,
		ticks: 170624,
	},
	{
		end: 11.039,
		lastPts: 11.016667,
		lastDur: 0.091667,
		total: 11.108333,
		ticks: 170624,
	},
	{
		end: 11.022,
		lastPts: 11.016667,
		lastDur: 0.091667,
		total: 11.108333,
		ticks: 170624,
	},
	{
		end: 8.37,
		lastPts: 8.366667,
		lastDur: 0.075,
		total: 8.441667,
		ticks: 129664,
	},
] as const;

function ticks(seconds: number): number {
	return Math.round(seconds * TB);
}

function input(
	end: number,
	lastPts: number,
	lastDur: number,
	totalTicks: number,
	maxHold = ticks(0.208333),
) {
	return {
		keepRanges: [{ start: 0, end }],
		timescale: TB,
		maxHoldTicks: maxHold,
		durationTicks: totalTicks,
		rangeSnaps: [
			{
				firstPts: 0,
				lastPts: ticks(lastPts),
				lastDur: ticks(lastDur),
			},
		],
	};
}

describe("snapped duration check", () => {
	it("accepts a legal hold and rejects the next frame", () => {
		expect(
			snappedDurationError(input(5.641, 5.633333, 0.141667, 88704)),
		).toBeNull();
		expect(
			snappedDurationError(input(5.641, 5.775, 0.133333, ticks(5.908333))),
		).toMatch(/outside/);
	});

	it.each(SCOUT)("accepts scout row end $end", (row) => {
		expect(
			snappedDurationError(input(row.end, row.lastPts, row.lastDur, row.ticks)),
		).toBeNull();
	});

	it("rejects a total that is not the snapped span", () => {
		expect(
			snappedDurationError(input(5.641, 5.633333, 0.141667, 88706)),
		).toMatch(/duration ticks/);
	});
});

// cap-fzp.8.7.36: a keep range running to the end of a source whose container
// (audio) outlasts its last video frame must not fail publish, but only when
// the origin attests that the source's final video frame was kept.
describe("source tail past last video frame", () => {
	const timescale = 12000;
	const snap = { firstPts: 0, lastPts: 142.85 * 12000, lastDur: 100 };
	const sourceEndTicks = snap.lastPts + snap.lastDur;
	const base = {
		timescale,
		maxHoldTicks: 2048,
		durationTicks: snap.lastPts + snap.lastDur,
		rangeSnaps: [snap],
		keepRanges: [{ start: 0, end: 142.933 }],
		sourceDuration: 142.933,
	};
	it("accepts when the final source frame is kept and the range ends at sourceDuration", () => {
		expect(snappedDurationError({ ...base, sourceEndTicks })).toBeNull();
	});
	it("rejects when the origin output is missing the final source frame (Sol fix16 item 2)", () => {
		expect(
			snappedDurationError({ ...base, sourceEndTicks: sourceEndTicks + 100 }),
		).toMatch(/is outside/);
	});
	it("rejects without a signed source end (old attestations stay strict)", () => {
		expect(snappedDurationError(base)).toMatch(/is outside/);
	});
	it("rejects when the range is not at the source end", () => {
		expect(
			snappedDurationError({ ...base, sourceEndTicks, sourceDuration: 150 }),
		).toMatch(/is outside/);
	});
	it("rejects when the range ends beyond sourceDuration", () => {
		expect(
			snappedDurationError({
				...base,
				sourceEndTicks,
				keepRanges: [{ start: 0, end: 143.5 }],
			}),
		).toMatch(/is outside/);
	});
});
