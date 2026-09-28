export const PLAYLIST_ORIGIN_SLACK_SECONDS = 0.05;

export type RangeSnap = {
	firstPts: number;
	lastPts: number;
	lastDur: number;
};

export type SnappedDurationInput = {
	keepRanges: { start: number; end: number }[];
	timescale: number;
	maxHoldTicks: number;
	durationTicks: number;
	rangeSnaps: RangeSnap[];
	/** Source container duration; a final range may end past the last video frame by < one hold (cap-fzp.8.7.36). */
	sourceDuration?: number;
};

export function snappedDurationError(
	input: SnappedDurationInput,
): string | null {
	const {
		keepRanges,
		timescale,
		maxHoldTicks,
		durationTicks,
		rangeSnaps,
		sourceDuration,
	} = input;
	if (
		!Number.isSafeInteger(timescale) ||
		timescale <= 0 ||
		!Number.isSafeInteger(maxHoldTicks) ||
		maxHoldTicks <= 0 ||
		!Number.isSafeInteger(durationTicks) ||
		durationTicks <= 0
	) {
		return "attested duration ticks are missing";
	}
	if (rangeSnaps.length !== keepRanges.length) {
		return `attested ranges ${rangeSnaps.length} != spec ${keepRanges.length}`;
	}
	const maxHold = maxHoldTicks / timescale;
	let spanTicks = 0;
	for (let index = 0; index < rangeSnaps.length; index += 1) {
		const range = keepRanges[index];
		const snap = rangeSnaps[index];
		if (
			!range ||
			!snap ||
			!Number.isSafeInteger(snap.firstPts) ||
			!Number.isSafeInteger(snap.lastPts) ||
			!Number.isSafeInteger(snap.lastDur) ||
			snap.firstPts < 0 ||
			snap.lastPts < snap.firstPts ||
			snap.lastDur <= 0
		) {
			return `attested range ${index} is malformed`;
		}
		const first = snap.firstPts / timescale;
		const last = snap.lastPts / timescale;
		const lastEnd = (snap.lastPts + snap.lastDur) / timescale;
		if (first < range.start) {
			return `attested range ${index} firstPts ${first} < start ${range.start}`;
		}
		if (first - range.start >= maxHold) {
			return `attested range ${index} start gap ${first - range.start} >= max hold ${maxHold}`;
		}
		const endsAtSourceTail =
			index === rangeSnaps.length - 1 &&
			typeof sourceDuration === "number" &&
			Math.abs(range.end - sourceDuration) <= 0.001 &&
			range.end > lastEnd &&
			range.end - lastEnd < maxHold;
		if (!endsAtSourceTail && !(last < range.end && range.end <= lastEnd)) {
			return `attested range ${index} end ${range.end} is outside (${last}, ${lastEnd}]`;
		}
		spanTicks += snap.lastPts + snap.lastDur - snap.firstPts;
	}
	if (Math.abs(spanTicks - durationTicks) > 1) {
		return `attested duration ticks ${durationTicks} != snapped span ${spanTicks}`;
	}
	return null;
}

export function snapsCoveringRanges(
	ranges: { start: number; end: number }[],
	timescale = 1000,
): {
	timescale: number;
	maxHoldTicks: number;
	durationTicks: number;
	rangeSnaps: RangeSnap[];
	durationSeconds: number;
} {
	const maxHoldTicks = timescale;
	const rangeSnaps = ranges.map((range) => {
		const firstPts = Math.ceil(range.start * timescale - 1e-9);
		const endTicks = Math.ceil(range.end * timescale - 1e-9);
		const lastPts = Math.max(firstPts, endTicks - 1);
		const lastDur = Math.max(1, endTicks - lastPts);
		return { firstPts, lastPts, lastDur };
	});
	const durationTicks = rangeSnaps.reduce(
		(sum, snap) => sum + (snap.lastPts + snap.lastDur - snap.firstPts),
		0,
	);
	return {
		timescale,
		maxHoldTicks,
		durationTicks,
		rangeSnaps,
		durationSeconds: durationTicks / timescale,
	};
}
