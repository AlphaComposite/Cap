import type {
	VideoAutoCuts,
	VideoEditRange,
	VideoEditSpec,
	VideoEditSpecV2,
} from "@cap/database/types";

const EPSILON = 0.001;
const MIN_RANGE_DURATION = 0.05;
const MAX_EDIT_DURATION_SECONDS = 31 * 24 * 60 * 60;
const MAX_EDIT_RANGE_COUNT = 5_000;
const MAX_AUTO_CUT_METADATA_MS = MAX_EDIT_DURATION_SECONDS * 1000;

export type VideoTimelineState = {
	duration: number;
	trimStart: number;
	trimEnd: number;
	splitPoints: number[];
	deletedRanges: VideoEditRange[];
	autoCuts?: VideoAutoCuts;
	selectedSegmentId: string | null;
};

export type VideoTimelineSegment = VideoEditRange & {
	id: string;
	deleted: boolean;
	selected: boolean;
};

export type VideoTimelineDisplaySegment = VideoTimelineSegment & {
	displayStart: number;
	displayEnd: number;
};

export type VideoTimelineDisplaySplitPoint = {
	id: string;
	time: number;
	sourceTime: number;
	sourceTimes: number[];
	splitIndices: number[];
	removable: boolean;
};

export type VideoTimelineDisplaySplitDragHandle = "center" | "left" | "right";

export type TimelineHistory = {
	entries: VideoTimelineState[];
	index: number;
};

const isFiniteNumber = (value: number) => Number.isFinite(value);

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonNegativeNumber(value: unknown, max: number) {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= max
		? value
		: null;
}

function parseCount(value: unknown) {
	return Number.isInteger(value) &&
		typeof value === "number" &&
		value >= 0 &&
		value <= MAX_EDIT_RANGE_COUNT
		? value
		: null;
}

function parseEditRanges(value: unknown, duration: number) {
	if (!Array.isArray(value) || value.length > MAX_EDIT_RANGE_COUNT) return null;
	const ranges: VideoEditRange[] = [];
	for (const item of value) {
		if (!isUnknownRecord(item)) return null;
		const start = parseNonNegativeNumber(item.start, duration);
		const end = parseNonNegativeNumber(item.end, duration);
		if (start === null || end === null) return null;
		ranges.push({ start, end });
	}
	return ranges;
}

export function roundEditTime(value: number) {
	return Math.round(value * 1000) / 1000;
}

export function clampEditTime(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function normalizeDuration(duration: number) {
	return isFiniteNumber(duration) && duration > 0 ? roundEditTime(duration) : 0;
}

function getSegmentId(start: number, end: number) {
	return `${roundEditTime(start)}:${roundEditTime(end)}`;
}

function getDefaultAutoCuts(): VideoAutoCuts {
	return {
		silence: {
			enabled: false,
			ranges: [],
			thresholdMs: 800,
			padMs: 150,
			removedMs: 0,
			gapCount: 0,
		},
		fillers: {
			enabled: false,
			ranges: [],
			mode: "ums",
			padMs: 80,
			removedCount: 0,
			skippedCount: 0,
		},
	};
}

function normalizeAutoCuts(
	autoCuts: VideoTimelineState["autoCuts"],
	duration: number,
): VideoAutoCuts {
	const defaults = getDefaultAutoCuts();
	return {
		silence: {
			...defaults.silence,
			...autoCuts?.silence,
			ranges: normalizeKeepRanges(
				autoCuts?.silence.ranges ?? defaults.silence.ranges,
				duration,
			).keepRanges,
		},
		fillers: {
			...defaults.fillers,
			...autoCuts?.fillers,
			ranges: normalizeKeepRanges(
				autoCuts?.fillers.ranges ?? defaults.fillers.ranges,
				duration,
			).keepRanges,
		},
	};
}

function getEffectiveDeletedRanges(state: VideoTimelineState) {
	const autoCuts = normalizeAutoCuts(state.autoCuts, state.duration);
	return normalizeKeepRanges(
		[
			...state.deletedRanges,
			...(autoCuts.silence.enabled ? autoCuts.silence.ranges : []),
			...(autoCuts.fillers.enabled ? autoCuts.fillers.ranges : []),
		],
		state.duration,
	).keepRanges;
}

function getDisplayDeletedRanges(state: VideoTimelineState) {
	return getEffectiveDeletedRanges(state);
}

export function normalizeKeepRanges(
	keepRanges: VideoEditRange[],
	sourceDuration: number,
): VideoEditSpec {
	const duration = normalizeDuration(sourceDuration);
	if (duration <= 0) {
		return { version: 1, sourceDuration: 0, keepRanges: [] };
	}

	const sortedRanges = keepRanges
		.map((range) => {
			const start = isFiniteNumber(range.start)
				? clampEditTime(range.start, 0, duration)
				: 0;
			const end = isFiniteNumber(range.end)
				? clampEditTime(range.end, 0, duration)
				: 0;
			return {
				start: roundEditTime(Math.min(start, end)),
				end: roundEditTime(Math.max(start, end)),
			};
		})
		.filter((range) => range.end - range.start >= MIN_RANGE_DURATION)
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const mergedRanges: VideoEditRange[] = [];
	for (const range of sortedRanges) {
		const previous = mergedRanges.at(-1);
		if (previous && range.start <= previous.end + EPSILON) {
			previous.end = roundEditTime(Math.max(previous.end, range.end));
			continue;
		}
		mergedRanges.push({ ...range });
	}

	return {
		version: 1,
		sourceDuration: duration,
		keepRanges: mergedRanges,
	};
}

export function createIdentityEditSpec(sourceDuration: number): VideoEditSpec {
	const duration = normalizeDuration(sourceDuration);
	return normalizeKeepRanges(
		duration > 0 ? [{ start: 0, end: duration }] : [],
		duration,
	);
}

export function normalizeVideoEditSpec(editSpec: VideoEditSpec): VideoEditSpec {
	const duration = normalizeDuration(editSpec.sourceDuration);
	if (editSpec.version === 1) {
		return normalizeKeepRanges(editSpec.keepRanges, duration);
	}

	const manualKeepRanges = normalizeKeepRanges(
		editSpec.manualKeepRanges,
		duration,
	).keepRanges;
	const autoCuts = normalizeAutoCuts(editSpec.autoCuts, duration);
	const cutRanges = [
		...(autoCuts.silence.enabled ? autoCuts.silence.ranges : []),
		...(autoCuts.fillers.enabled ? autoCuts.fillers.ranges : []),
	];
	return {
		version: 2,
		sourceDuration: duration,
		manualKeepRanges,
		autoCuts,
		keepRanges: subtractRanges(manualKeepRanges, cutRanges, duration),
	};
}

export function parseVideoEditSpec(value: unknown): VideoEditSpec {
	if (!isUnknownRecord(value) || (value.version !== 1 && value.version !== 2)) {
		throw new Error("Invalid video edit specification");
	}
	const sourceDuration = parseNonNegativeNumber(
		value.sourceDuration,
		MAX_EDIT_DURATION_SECONDS,
	);
	if (sourceDuration === null || sourceDuration <= 0) {
		throw new Error("Invalid video edit specification");
	}
	const keepRanges = parseEditRanges(value.keepRanges, sourceDuration);
	if (!keepRanges) throw new Error("Invalid video edit specification");
	if (value.version === 1) {
		return normalizeKeepRanges(keepRanges, sourceDuration);
	}

	const manualKeepRanges = parseEditRanges(
		value.manualKeepRanges,
		sourceDuration,
	);
	const autoCuts = value.autoCuts;
	if (
		!manualKeepRanges ||
		!isUnknownRecord(autoCuts) ||
		!isUnknownRecord(autoCuts.silence) ||
		!isUnknownRecord(autoCuts.fillers)
	) {
		throw new Error("Invalid video edit specification");
	}
	const silenceRanges = parseEditRanges(
		autoCuts.silence.ranges,
		sourceDuration,
	);
	const fillerRanges = parseEditRanges(autoCuts.fillers.ranges, sourceDuration);
	if (
		silenceRanges &&
		fillerRanges &&
		keepRanges.length +
			manualKeepRanges.length +
			silenceRanges.length +
			fillerRanges.length >
			MAX_EDIT_RANGE_COUNT
	) {
		throw new Error("Invalid video edit specification");
	}
	const thresholdMs = parseNonNegativeNumber(
		autoCuts.silence.thresholdMs,
		MAX_AUTO_CUT_METADATA_MS,
	);
	const silencePadMs = parseNonNegativeNumber(
		autoCuts.silence.padMs,
		MAX_AUTO_CUT_METADATA_MS,
	);
	const removedMs = parseNonNegativeNumber(
		autoCuts.silence.removedMs,
		MAX_AUTO_CUT_METADATA_MS,
	);
	const gapCount = parseCount(autoCuts.silence.gapCount);
	const fillerPadMs = parseNonNegativeNumber(
		autoCuts.fillers.padMs,
		MAX_AUTO_CUT_METADATA_MS,
	);
	const removedCount = parseCount(autoCuts.fillers.removedCount);
	const skippedCount = parseCount(autoCuts.fillers.skippedCount);
	if (
		typeof autoCuts.silence.enabled !== "boolean" ||
		typeof autoCuts.fillers.enabled !== "boolean" ||
		autoCuts.fillers.mode !== "ums" ||
		!silenceRanges ||
		!fillerRanges ||
		thresholdMs === null ||
		silencePadMs === null ||
		removedMs === null ||
		gapCount === null ||
		fillerPadMs === null ||
		removedCount === null ||
		skippedCount === null
	) {
		throw new Error("Invalid video edit specification");
	}

	return normalizeVideoEditSpec({
		version: 2,
		sourceDuration,
		keepRanges,
		manualKeepRanges,
		autoCuts: {
			silence: {
				enabled: autoCuts.silence.enabled,
				ranges: silenceRanges,
				thresholdMs,
				padMs: silencePadMs,
				removedMs,
				gapCount,
			},
			fillers: {
				enabled: autoCuts.fillers.enabled,
				ranges: fillerRanges,
				mode: "ums",
				padMs: fillerPadMs,
				removedCount,
				skippedCount,
			},
		},
	});
}

export function areEditSpecDocumentsEquivalent(
	left: VideoEditSpec,
	right: VideoEditSpec,
) {
	return (
		JSON.stringify(normalizeVideoEditSpec(left)) ===
		JSON.stringify(normalizeVideoEditSpec(right))
	);
}

export function areEditSpecsEquivalent(
	left: VideoEditSpec,
	right: VideoEditSpec,
) {
	const normalizedLeft = normalizeKeepRanges(
		left.keepRanges,
		left.sourceDuration,
	);
	const normalizedRight = normalizeKeepRanges(
		right.keepRanges,
		right.sourceDuration,
	);

	if (
		Math.abs(normalizedLeft.sourceDuration - normalizedRight.sourceDuration) >
		EPSILON
	) {
		return false;
	}

	if (normalizedLeft.keepRanges.length !== normalizedRight.keepRanges.length) {
		return false;
	}

	return normalizedLeft.keepRanges.every((leftRange, index) => {
		const rightRange = normalizedRight.keepRanges[index];
		return (
			rightRange !== undefined &&
			Math.abs(leftRange.start - rightRange.start) <= EPSILON &&
			Math.abs(leftRange.end - rightRange.end) <= EPSILON
		);
	});
}

export function areTimelineStatesEquivalent(
	left: VideoTimelineState,
	right: VideoTimelineState,
) {
	const normalizedLeft = normalizeTimelineState(left);
	const normalizedRight = normalizeTimelineState(right);

	if (
		Math.abs(normalizedLeft.duration - normalizedRight.duration) > EPSILON ||
		Math.abs(normalizedLeft.trimStart - normalizedRight.trimStart) > EPSILON ||
		Math.abs(normalizedLeft.trimEnd - normalizedRight.trimEnd) > EPSILON
	) {
		return false;
	}

	if (
		normalizedLeft.splitPoints.length !== normalizedRight.splitPoints.length ||
		normalizedLeft.deletedRanges.length !== normalizedRight.deletedRanges.length
	) {
		return false;
	}

	if (
		JSON.stringify(
			normalizeAutoCuts(normalizedLeft.autoCuts, normalizedLeft.duration),
		) !==
		JSON.stringify(
			normalizeAutoCuts(normalizedRight.autoCuts, normalizedRight.duration),
		)
	) {
		return false;
	}

	return (
		normalizedLeft.splitPoints.every(
			(point, index) =>
				Math.abs(point - (normalizedRight.splitPoints[index] ?? 0)) <= EPSILON,
		) &&
		normalizedLeft.deletedRanges.every((leftRange, index) => {
			const rightRange = normalizedRight.deletedRanges[index];
			return (
				rightRange !== undefined &&
				Math.abs(leftRange.start - rightRange.start) <= EPSILON &&
				Math.abs(leftRange.end - rightRange.end) <= EPSILON
			);
		})
	);
}

export function getEditSpecOutputDuration(editSpec: VideoEditSpec) {
	return roundEditTime(
		editSpec.keepRanges.reduce(
			(total, range) => total + Math.max(0, range.end - range.start),
			0,
		),
	);
}

export function mapSourceTimeToOutputTime(
	sourceTime: number,
	editSpec: VideoEditSpec,
) {
	if (!isFiniteNumber(sourceTime)) return null;

	const normalized = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	let outputTime = 0;

	for (const range of normalized.keepRanges) {
		if (
			sourceTime >= range.start - EPSILON &&
			sourceTime <= range.end + EPSILON
		) {
			return roundEditTime(
				outputTime +
					clampEditTime(sourceTime - range.start, 0, range.end - range.start),
			);
		}
		outputTime += range.end - range.start;
	}

	return null;
}

export function mapOutputTimeToSourceTime(
	outputTime: number,
	editSpec: VideoEditSpec,
) {
	if (!isFiniteNumber(outputTime)) return null;

	const normalized = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	let elapsed = 0;

	for (const range of normalized.keepRanges) {
		const rangeDuration = range.end - range.start;
		if (outputTime <= elapsed + rangeDuration + EPSILON) {
			return roundEditTime(
				range.start + clampEditTime(outputTime - elapsed, 0, rangeDuration),
			);
		}
		elapsed += rangeDuration;
	}

	return null;
}

export type VideoChapter = { title: string; start: number };

/**
 * Maps an output chapter cue into source-media time for editor playback.
 * At an output splice, chapter cues belong to the next playable range rather
 * than the final frame of the preceding range. The final output boundary has
 * no range to its right and therefore maps to the source end.
 */
export function mapOutputChapterTimeToSourceTime(
	outputTime: number,
	editSpec: VideoEditSpec,
) {
	if (!isFiniteNumber(outputTime)) return null;

	const normalized = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	let elapsed = 0;

	for (let index = 0; index < normalized.keepRanges.length; index++) {
		const range = normalized.keepRanges[index];
		if (!range) continue;
		const rangeDuration = range.end - range.start;
		const outputEnd = elapsed + rangeDuration;
		if (outputTime < outputEnd - EPSILON) {
			return roundEditTime(
				range.start + clampEditTime(outputTime - elapsed, 0, rangeDuration),
			);
		}
		if (outputTime <= outputEnd + EPSILON) {
			return roundEditTime(
				normalized.keepRanges[index + 1]?.start ?? range.end,
			);
		}
		elapsed = outputEnd;
	}

	return null;
}

export function mapOutputChaptersToSource(
	chapters: readonly VideoChapter[],
	savedEditSpec: VideoEditSpec,
): VideoChapter[] {
	return chapters.flatMap((chapter) => {
		const sourceTime = mapOutputChapterTimeToSourceTime(
			chapter.start,
			savedEditSpec,
		);
		return sourceTime === null ? [] : [{ ...chapter, start: sourceTime }];
	});
}

/**
 * Projects immutable source-timeline chapter starts into an edited output.
 * Chapters removed by a cut snap to the next playable boundary. If no footage
 * remains after the source timestamp, they deterministically snap to output end.
 */
export function projectSourceChaptersToOutput(
	chapters: readonly VideoChapter[],
	editSpec: VideoEditSpec,
): VideoChapter[] {
	const normalized = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	const outputEnd = getEditSpecOutputDuration(normalized);

	return chapters.flatMap((chapter) => {
		if (!isFiniteNumber(chapter.start)) return [];
		const direct = mapSourceTimeToOutputTime(chapter.start, normalized);
		if (direct !== null) return [{ ...chapter, start: direct }];

		let outputCursor = 0;
		for (const range of normalized.keepRanges) {
			if (range.start > chapter.start + EPSILON) {
				return [{ ...chapter, start: roundEditTime(outputCursor) }];
			}
			outputCursor += range.end - range.start;
		}
		return [{ ...chapter, start: outputEnd }];
	});
}

export function mapOutputRangeToSourceRanges(
	outputRange: VideoEditRange,
	editSpec: VideoEditSpec,
) {
	const normalized = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	const sourceRanges: VideoEditRange[] = [];
	let outputCursor = 0;

	for (const sourceRange of normalized.keepRanges) {
		const sourceRangeDuration = sourceRange.end - sourceRange.start;
		const outputStart = outputCursor;
		const outputEnd = outputCursor + sourceRangeDuration;
		const overlapStart = Math.max(outputRange.start, outputStart);
		const overlapEnd = Math.min(outputRange.end, outputEnd);

		if (overlapEnd - overlapStart >= MIN_RANGE_DURATION) {
			sourceRanges.push({
				start: roundEditTime(sourceRange.start + overlapStart - outputStart),
				end: roundEditTime(sourceRange.start + overlapEnd - outputStart),
			});
		}

		outputCursor = outputEnd;
	}

	return normalizeKeepRanges(sourceRanges, normalized.sourceDuration)
		.keepRanges;
}

export function composeEditSpecs(
	previousSourceSpec: VideoEditSpec,
	nextOutputSpec: VideoEditSpec,
) {
	const previous = normalizeKeepRanges(
		previousSourceSpec.keepRanges,
		previousSourceSpec.sourceDuration,
	);
	const previousOutputDuration = getEditSpecOutputDuration(previous);
	const next = normalizeKeepRanges(
		nextOutputSpec.keepRanges,
		previousOutputDuration,
	);
	const sourceRanges = next.keepRanges.flatMap((range) =>
		mapOutputRangeToSourceRanges(range, previous),
	);

	return normalizeKeepRanges(sourceRanges, previous.sourceDuration);
}

export function remapCurrentOutputTimeThroughEdit(
	currentOutputTime: number | null,
	previousSourceSpec: VideoEditSpec,
	nextSourceSpec: VideoEditSpec,
) {
	if (currentOutputTime === null) return null;
	const sourceTime = mapOutputTimeToSourceTime(
		currentOutputTime,
		previousSourceSpec,
	);
	if (sourceTime === null) return null;
	return mapSourceTimeToOutputTime(sourceTime, nextSourceSpec);
}

export function subtractRanges(
	baseRanges: VideoEditRange[],
	deletedRanges: VideoEditRange[],
	sourceDuration: number,
) {
	const bases = normalizeKeepRanges(baseRanges, sourceDuration).keepRanges;
	const deleted = normalizeKeepRanges(deletedRanges, sourceDuration).keepRanges;
	const ranges: VideoEditRange[] = [];
	let deletedIndex = 0;

	for (const base of bases) {
		while (
			deletedIndex < deleted.length &&
			(deleted[deletedIndex]?.end ?? 0) <= base.start + EPSILON
		) {
			deletedIndex++;
		}

		let cursor = base.start;
		let scanIndex = deletedIndex;
		while (scanIndex < deleted.length) {
			const cut = deleted[scanIndex];
			if (!cut || cut.start >= base.end - EPSILON) break;
			if (cut.start - cursor >= MIN_RANGE_DURATION) {
				ranges.push({
					start: roundEditTime(cursor),
					end: roundEditTime(Math.min(cut.start, base.end)),
				});
			}
			cursor = Math.max(cursor, cut.end);
			if (cursor >= base.end - EPSILON) break;
			scanIndex++;
		}
		deletedIndex = scanIndex;
		if (base.end - cursor >= MIN_RANGE_DURATION) {
			ranges.push({
				start: roundEditTime(cursor),
				end: roundEditTime(base.end),
			});
		}
	}

	return normalizeKeepRanges(ranges, sourceDuration).keepRanges;
}

export function createTimelineState(duration: number): VideoTimelineState {
	const normalizedDuration = normalizeDuration(duration);
	return {
		duration: normalizedDuration,
		trimStart: 0,
		trimEnd: normalizedDuration,
		splitPoints: [],
		deletedRanges: [],
		autoCuts: getDefaultAutoCuts(),
		selectedSegmentId: null,
	};
}

export function createTimelineStateFromEditSpec(
	editSpec: VideoEditSpec,
): VideoTimelineState {
	const duration = normalizeDuration(editSpec.sourceDuration);
	const manualKeepRanges = normalizeKeepRanges(
		editSpec.version === 2 ? editSpec.manualKeepRanges : editSpec.keepRanges,
		duration,
	).keepRanges;
	const deletedRanges = subtractRanges(
		[{ start: 0, end: duration }],
		manualKeepRanges,
		duration,
	);
	return normalizeTimelineState({
		duration,
		trimStart: 0,
		trimEnd: duration,
		splitPoints: deletedRanges
			.flatMap((range) => [range.start, range.end])
			.filter((point) => point > 0 && point < duration),
		deletedRanges,
		autoCuts:
			editSpec.version === 2
				? normalizeAutoCuts(editSpec.autoCuts, duration)
				: getDefaultAutoCuts(),
		selectedSegmentId: null,
	});
}

export function normalizeTimelineState(
	state: VideoTimelineState,
): VideoTimelineState {
	const duration = normalizeDuration(state.duration);
	const trimStart = clampEditTime(state.trimStart, 0, duration);
	const trimEnd = clampEditTime(state.trimEnd, 0, duration);
	const start = roundEditTime(Math.min(trimStart, trimEnd));
	const end = roundEditTime(Math.max(trimStart, trimEnd));
	const rawSplitPoints = Array.from(
		new Set(
			state.splitPoints
				.filter((point) => isFiniteNumber(point))
				.map((point) => roundEditTime(clampEditTime(point, start, end)))
				.filter(
					(point) =>
						point - start >= MIN_RANGE_DURATION &&
						end - point >= MIN_RANGE_DURATION,
				),
		),
	).sort((a, b) => a - b);
	const deletedRanges = subtractRanges(
		normalizeKeepRanges(state.deletedRanges, duration).keepRanges,
		[],
		duration,
	).filter((range) => range.end > start && range.start < end);
	const autoCuts = normalizeAutoCuts(state.autoCuts, duration);
	const splitPoints = rawSplitPoints.filter(
		(point) =>
			!deletedRanges.some(
				(range) => point > range.start + EPSILON && point < range.end - EPSILON,
			),
	);
	const segments = getTimelineSegments({
		...state,
		duration,
		trimStart: start,
		trimEnd: end,
		splitPoints,
		deletedRanges,
		autoCuts,
	});
	const selectedSegmentId =
		state.selectedSegmentId &&
		segments.some((segment) => segment.id === state.selectedSegmentId)
			? state.selectedSegmentId
			: null;

	return {
		duration,
		trimStart: start,
		trimEnd: end,
		splitPoints,
		deletedRanges,
		autoCuts,
		selectedSegmentId,
	};
}

export function getTimelineSegments(
	state: VideoTimelineState,
): VideoTimelineSegment[] {
	const effectiveDeletedRanges = getEffectiveDeletedRanges(state);
	const boundaries = Array.from(
		new Set([
			state.trimStart,
			...state.splitPoints.filter(
				(point) => point > state.trimStart && point < state.trimEnd,
			),
			...effectiveDeletedRanges.flatMap((range) => [range.start, range.end]),
			state.trimEnd,
		]),
	)
		.filter((point) => point >= state.trimStart && point <= state.trimEnd)
		.map(roundEditTime)
		.sort((a, b) => a - b);

	const segments: VideoTimelineSegment[] = [];
	for (let index = 0; index < boundaries.length - 1; index++) {
		const start = boundaries[index] ?? 0;
		const end = boundaries[index + 1] ?? 0;
		if (end - start < MIN_RANGE_DURATION) continue;

		const id = getSegmentId(start, end);
		const midpoint = start + (end - start) / 2;
		const deleted = effectiveDeletedRanges.some(
			(range) =>
				midpoint >= range.start - EPSILON && midpoint <= range.end + EPSILON,
		);
		segments.push({
			id,
			start,
			end,
			deleted,
			selected: state.selectedSegmentId === id,
		});
	}

	return segments;
}

function getManualTimelineSegments(
	state: VideoTimelineState,
): VideoTimelineSegment[] {
	const boundaries = [
		state.trimStart,
		...state.splitPoints.filter(
			(point) => point > state.trimStart && point < state.trimEnd,
		),
		state.trimEnd,
	]
		.map(roundEditTime)
		.sort((a, b) => a - b);
	const deletedRanges = normalizeKeepRanges(
		state.deletedRanges,
		state.duration,
	).keepRanges;

	const segments: VideoTimelineSegment[] = [];
	for (let index = 0; index < boundaries.length - 1; index++) {
		const start = boundaries[index] ?? 0;
		const end = boundaries[index + 1] ?? 0;
		if (end - start < MIN_RANGE_DURATION) continue;
		const id = getSegmentId(start, end);
		const midpoint = start + (end - start) / 2;
		segments.push({
			id,
			start,
			end,
			deleted: deletedRanges.some(
				(range) =>
					midpoint >= range.start - EPSILON && midpoint <= range.end + EPSILON,
			),
			selected: state.selectedSegmentId === id,
		});
	}
	return segments;
}

export function getTimelineDisplayDuration(state: VideoTimelineState) {
	const duration = normalizeDuration(state.duration);
	const deletedDuration = getDisplayDeletedRanges({
		...state,
		duration,
	}).reduce((total, range) => total + Math.max(0, range.end - range.start), 0);
	return roundEditTime(Math.max(0, duration - deletedDuration));
}

export function mapTimelineSourceTimeToDisplayTime(
	state: VideoTimelineState,
	sourceTime: number,
) {
	const duration = normalizeDuration(state.duration);
	if (duration <= 0 || !isFiniteNumber(sourceTime)) return 0;

	const time = clampEditTime(sourceTime, 0, duration);
	let deletedBefore = 0;
	for (const range of getDisplayDeletedRanges({ ...state, duration })) {
		if (time <= range.start + EPSILON) break;
		if (time < range.end - EPSILON) {
			return roundEditTime(range.start - deletedBefore);
		}
		deletedBefore += range.end - range.start;
	}

	return roundEditTime(Math.max(0, time - deletedBefore));
}

export function mapTimelineDisplayTimeToSourceTime(
	state: VideoTimelineState,
	displayTime: number,
) {
	const duration = normalizeDuration(state.duration);
	const displayDuration = getTimelineDisplayDuration({ ...state, duration });
	if (duration <= 0 || displayDuration <= 0 || !isFiniteNumber(displayTime)) {
		return 0;
	}

	const time = clampEditTime(displayTime, 0, displayDuration);
	let sourceCursor = 0;
	let displayCursor = 0;
	for (const range of getDisplayDeletedRanges({ ...state, duration })) {
		const keptDuration = Math.max(0, range.start - sourceCursor);
		const displayEnd = displayCursor + keptDuration;
		if (time <= displayEnd + EPSILON) {
			return roundEditTime(
				clampEditTime(
					sourceCursor + time - displayCursor,
					sourceCursor,
					range.start,
				),
			);
		}
		sourceCursor = range.end;
		displayCursor = displayEnd;
	}

	return roundEditTime(
		clampEditTime(sourceCursor + time - displayCursor, sourceCursor, duration),
	);
}

export function getTimelineDisplaySegments(
	state: VideoTimelineState,
): VideoTimelineDisplaySegment[] {
	const normalized = normalizeTimelineState(state);
	const keepRanges = getTimelineKeepRanges(normalized);
	const segments: VideoTimelineDisplaySegment[] = [];

	for (const range of keepRanges) {
		const boundaries = [
			range.start,
			...normalized.splitPoints.filter(
				(point) => point > range.start + EPSILON && point < range.end - EPSILON,
			),
			range.end,
		].sort((a, b) => a - b);

		for (let index = 0; index < boundaries.length - 1; index++) {
			const start = boundaries[index] ?? 0;
			const end = boundaries[index + 1] ?? 0;
			if (end - start < MIN_RANGE_DURATION) continue;

			const id = getSegmentId(start, end);
			const displayStart = mapTimelineSourceTimeToDisplayTime(
				normalized,
				start,
			);
			const displayEnd = mapTimelineSourceTimeToDisplayTime(normalized, end);
			if (displayEnd - displayStart < MIN_RANGE_DURATION) continue;

			segments.push({
				id,
				start,
				end,
				displayStart,
				displayEnd,
				deleted: false,
				selected: normalized.selectedSegmentId === id,
			});
		}
	}

	return segments;
}

export function getTimelineDisplaySplitPoints(
	state: VideoTimelineState,
): VideoTimelineDisplaySplitPoint[] {
	const normalized = normalizeTimelineState(state);
	const segments = getTimelineDisplaySegments(normalized);
	const sortedSplitPoints = [...normalized.splitPoints].sort((a, b) => a - b);
	const manualDeletedRanges = normalizeKeepRanges(
		normalized.deletedRanges,
		normalized.duration,
	).keepRanges;
	const autoCuts = normalizeAutoCuts(normalized.autoCuts, normalized.duration);
	const activeAutoRanges = [
		...(autoCuts.silence.enabled ? autoCuts.silence.ranges : []),
		...(autoCuts.fillers.enabled ? autoCuts.fillers.ranges : []),
	];
	const markers: VideoTimelineDisplaySplitPoint[] = [];

	for (let index = 0; index < segments.length - 1; index++) {
		const current = segments[index];
		const next = segments[index + 1];
		if (!current || !next) continue;

		const sourceTimes = [current.end];
		if (Math.abs(current.end - next.start) > EPSILON) {
			sourceTimes.push(next.start);
		}

		const splitIndices = sortedSplitPoints.flatMap((point, splitIndex) =>
			sourceTimes.some((sourceTime) => Math.abs(point - sourceTime) <= EPSILON)
				? [splitIndex]
				: [],
		);
		const time = current.displayEnd;
		const gapStart = Math.min(...sourceTimes);
		const gapEnd = Math.max(...sourceTimes);
		const overlapsGap = (range: VideoEditRange) =>
			range.end > gapStart + EPSILON && range.start < gapEnd - EPSILON;
		const removable =
			sourceTimes.length === 1
				? splitIndices.length > 0
				: manualDeletedRanges.some(overlapsGap) &&
					!activeAutoRanges.some(overlapsGap);
		markers.push({
			id: `${roundEditTime(time)}:${sourceTimes.map(roundEditTime).join(":")}`,
			time,
			sourceTime: current.end,
			sourceTimes,
			splitIndices,
			removable,
		});
	}

	return markers;
}

function getTimelineDisplaySplitDragSourceTime(
	splitPoint: VideoTimelineDisplaySplitPoint,
	handle: VideoTimelineDisplaySplitDragHandle,
) {
	if (splitPoint.sourceTimes.length === 1) return splitPoint.sourceTime;

	if (handle === "left") return Math.min(...splitPoint.sourceTimes);
	if (handle === "right") return Math.max(...splitPoint.sourceTimes);

	return splitPoint.sourceTime;
}

export function getTimelineDisplaySplitDragTargetTime(
	state: VideoTimelineState,
	splitPointIndex: number,
	handle: VideoTimelineDisplaySplitDragHandle,
	sourceTime: number,
) {
	const splitPoint = getTimelineDisplaySplitPoints(state)[splitPointIndex];
	if (!splitPoint?.removable || !isFiniteNumber(sourceTime)) return null;
	if (splitPoint.sourceTimes.length === 1) return sourceTime;

	const leftSourceTime = Math.min(...splitPoint.sourceTimes);
	const rightSourceTime = Math.max(...splitPoint.sourceTimes);
	if (handle === "left") return Math.min(sourceTime, leftSourceTime);
	if (handle === "right") return Math.max(sourceTime, rightSourceTime);

	if (sourceTime <= leftSourceTime + EPSILON) return sourceTime;
	if (sourceTime >= rightSourceTime - EPSILON) return sourceTime;

	return sourceTime - leftSourceTime < rightSourceTime - sourceTime
		? leftSourceTime
		: rightSourceTime;
}

export function dragTimelineDisplaySplitPoint(
	state: VideoTimelineState,
	splitPointIndex: number,
	handle: VideoTimelineDisplaySplitDragHandle,
	sourceTime: number,
) {
	const splitPoint = getTimelineDisplaySplitPoints(state)[splitPointIndex];
	if (!splitPoint?.removable) return state;

	const targetTime = getTimelineDisplaySplitDragTargetTime(
		state,
		splitPointIndex,
		handle,
		sourceTime,
	);
	if (targetTime === null) return state;

	return dragSplitForShrink(
		state,
		getTimelineDisplaySplitDragSourceTime(splitPoint, handle),
		targetTime,
	);
}

export function removeTimelineDisplaySplitPoint(
	state: VideoTimelineState,
	splitPointIndex: number,
): VideoTimelineState {
	const splitPoint = getTimelineDisplaySplitPoints(state)[splitPointIndex];
	if (!splitPoint?.removable) return state;

	if (splitPoint.sourceTimes.length === 1) {
		const splitIndex = splitPoint.splitIndices[0];
		return splitIndex === undefined
			? state
			: removeSplitPoint(state, splitIndex);
	}

	const restoreStart = Math.min(...splitPoint.sourceTimes);
	const restoreEnd = Math.max(...splitPoint.sourceTimes);
	const deletedRanges = normalizeKeepRanges(
		state.deletedRanges,
		state.duration,
	).keepRanges.flatMap((range) => {
		if (
			range.end <= restoreStart + EPSILON ||
			range.start >= restoreEnd - EPSILON
		) {
			return [range];
		}

		const nextRanges: VideoEditRange[] = [];
		if (restoreStart - range.start >= MIN_RANGE_DURATION) {
			nextRanges.push({ start: range.start, end: restoreStart });
		}
		if (range.end - restoreEnd >= MIN_RANGE_DURATION) {
			nextRanges.push({ start: restoreEnd, end: range.end });
		}
		return nextRanges;
	});
	const splitPoints = state.splitPoints.filter(
		(point) =>
			!splitPoint.sourceTimes.some(
				(sourceTime) => Math.abs(point - sourceTime) <= EPSILON,
			),
	);

	return normalizeTimelineState({
		...state,
		splitPoints,
		deletedRanges,
		selectedSegmentId: null,
	});
}

export function selectTimelineSegment(
	state: VideoTimelineState,
	segmentId: string,
): VideoTimelineState {
	const segments = getTimelineSegments(state);
	const segment = segments.find((segment) => segment.id === segmentId);
	if (!segment || segment.deleted) return state;
	return normalizeTimelineState({ ...state, selectedSegmentId: segmentId });
}

export function splitTimelineAt(
	state: VideoTimelineState,
	playheadTime: number,
): VideoTimelineState {
	if (
		!isFiniteNumber(playheadTime) ||
		playheadTime - state.trimStart < MIN_RANGE_DURATION ||
		state.trimEnd - playheadTime < MIN_RANGE_DURATION
	) {
		return state;
	}

	const normalizedTime = roundEditTime(
		clampEditTime(playheadTime, state.trimStart, state.trimEnd),
	);
	const isDuplicate = state.splitPoints.some(
		(point) => Math.abs(point - normalizedTime) < MIN_RANGE_DURATION,
	);
	const isDeleted = state.deletedRanges.some(
		(range) =>
			normalizedTime > range.start + EPSILON &&
			normalizedTime < range.end - EPSILON,
	);

	if (isDuplicate || isDeleted) return state;

	return normalizeTimelineState({
		...state,
		splitPoints: [...state.splitPoints, normalizedTime],
		selectedSegmentId: null,
	});
}

export function deleteSelectedTimelineSegment(
	state: VideoTimelineState,
): VideoTimelineState {
	if (!state.selectedSegmentId) return state;
	const segment = getTimelineSegments(state).find(
		(segment) => segment.id === state.selectedSegmentId,
	);
	if (!segment || segment.deleted) return state;

	return normalizeTimelineState({
		...state,
		deletedRanges: [...state.deletedRanges, segment],
		selectedSegmentId: null,
	});
}

export function deleteTimelineRanges(
	state: VideoTimelineState,
	ranges: readonly VideoEditRange[],
): VideoTimelineState {
	const normalized = normalizeTimelineState(state);
	const deletionRanges = normalizeKeepRanges(
		ranges.map((range) => ({
			start: clampEditTime(
				range.start,
				normalized.trimStart,
				normalized.trimEnd,
			),
			end: clampEditTime(range.end, normalized.trimStart, normalized.trimEnd),
		})),
		normalized.duration,
	).keepRanges;
	if (deletionRanges.length === 0) return normalized;

	const nextState = normalizeTimelineState({
		...normalized,
		splitPoints: [
			...normalized.splitPoints,
			...deletionRanges.flatMap((range) => [range.start, range.end]),
		],
		deletedRanges: [...normalized.deletedRanges, ...deletionRanges],
		selectedSegmentId: null,
	});

	return getTimelineKeepRanges(nextState).length > 0 ? nextState : normalized;
}

export function setTimelineAutoCutLayer<K extends keyof VideoAutoCuts>(
	state: VideoTimelineState,
	kind: K,
	update: Partial<VideoAutoCuts[K]> & { enabled: boolean },
): VideoTimelineState {
	const normalized = normalizeTimelineState(state);
	const current = normalizeAutoCuts(normalized.autoCuts, normalized.duration);
	const nextState = normalizeTimelineState({
		...normalized,
		autoCuts: {
			...current,
			[kind]: {
				...current[kind],
				...update,
				ranges: update.ranges ? [...update.ranges] : current[kind].ranges,
			},
		},
		selectedSegmentId: null,
	});
	return getTimelineKeepRanges(nextState).length > 0 ? nextState : normalized;
}

export function setTimelineTrim(
	state: VideoTimelineState,
	start: number,
	end: number,
): VideoTimelineState {
	const trimStart = clampEditTime(start, 0, state.duration);
	const trimEnd = clampEditTime(end, 0, state.duration);
	if (Math.abs(trimEnd - trimStart) < MIN_RANGE_DURATION) return state;

	return normalizeTimelineState({
		...state,
		trimStart,
		trimEnd,
		selectedSegmentId: null,
	});
}

export function moveSplitPoint(
	state: VideoTimelineState,
	splitIndex: number,
	newTime: number,
): VideoTimelineState {
	const sorted = [...state.splitPoints].sort((a, b) => a - b);
	if (splitIndex < 0 || splitIndex >= sorted.length) return state;
	const lowerBound =
		splitIndex > 0
			? (sorted[splitIndex - 1] ?? state.trimStart)
			: state.trimStart;
	const upperBound =
		splitIndex < sorted.length - 1
			? (sorted[splitIndex + 1] ?? state.trimEnd)
			: state.trimEnd;
	sorted[splitIndex] = clampEditTime(
		newTime,
		lowerBound + MIN_RANGE_DURATION,
		upperBound - MIN_RANGE_DURATION,
	);
	return normalizeTimelineState({
		...state,
		splitPoints: sorted,
		selectedSegmentId: null,
	});
}

export function removeSplitPoint(
	state: VideoTimelineState,
	splitIndex: number,
): VideoTimelineState {
	const sorted = [...state.splitPoints].sort((a, b) => a - b);
	if (splitIndex < 0 || splitIndex >= sorted.length) return state;
	const currentSegments = getManualTimelineSegments(state);
	sorted.splice(splitIndex, 1);
	const nextSegments = getManualTimelineSegments({
		...state,
		splitPoints: sorted,
	});
	const deletedRanges = nextSegments
		.filter((segment) => {
			const coveredSegments = currentSegments.filter(
				(currentSegment) =>
					currentSegment.start >= segment.start - EPSILON &&
					currentSegment.end <= segment.end + EPSILON,
			);
			return (
				coveredSegments.length > 0 &&
				coveredSegments.every((currentSegment) => currentSegment.deleted)
			);
		})
		.map(({ start, end }) => ({ start, end }));
	return normalizeTimelineState({
		...state,
		splitPoints: sorted,
		deletedRanges,
		selectedSegmentId: null,
	});
}

export function dragSplitForShrink(
	state: VideoTimelineState,
	originalPos: number,
	newPos: number,
): VideoTimelineState {
	if (Math.abs(newPos - originalPos) < EPSILON) return state;
	const lo = clampEditTime(
		Math.min(originalPos, newPos),
		state.trimStart,
		state.trimEnd,
	);
	const hi = clampEditTime(
		Math.max(originalPos, newPos),
		state.trimStart,
		state.trimEnd,
	);
	if (hi - lo < MIN_RANGE_DURATION) return state;

	const splits = [...state.splitPoints];
	if (!splits.some((p) => Math.abs(p - originalPos) < EPSILON)) {
		splits.push(originalPos);
	}
	if (!splits.some((p) => Math.abs(p - newPos) < EPSILON)) {
		splits.push(newPos);
	}

	return normalizeTimelineState({
		...state,
		splitPoints: splits,
		deletedRanges: [...state.deletedRanges, { start: lo, end: hi }],
		selectedSegmentId: null,
	});
}

/**
 * Trim a single clip (display segment) from one of its edges, Loom-style.
 *
 * Outer edges (the first clip's left edge, the last clip's right edge) move the
 * global in/out point (`trimStart`/`trimEnd`). Inner edges carve footage off the
 * clip via {@link dragSplitForShrink}, leaving the neighbouring clips untouched.
 * The carve only ever shrinks the clip it belongs to — it can never eat into an
 * adjacent clip — so dragging clip A's right edge and clip B's left edge are
 * independent operations even when A and B touch at a pure split.
 */
export function trimTimelineClipEdge(
	state: VideoTimelineState,
	clipId: string,
	edge: "start" | "end",
	sourceTime: number,
): VideoTimelineState {
	if (!isFiniteNumber(sourceTime)) return state;

	const normalized = normalizeTimelineState(state);
	const segments = getTimelineDisplaySegments(normalized);
	const clip = segments.find((segment) => segment.id === clipId);
	if (!clip) return state;

	// An outer edge moves the global in/out point ONLY when the clip actually sits
	// at that boundary. If footage was already carved off the front/back (a
	// collapsed deletedRange before/after this clip), moving the trim would
	// un-collapse it and balloon the timeline — so we carve instead, keeping the
	// display tight like every other clip edge.
	const movesTrimStart =
		segments[0]?.id === clipId && clip.start <= normalized.trimStart + EPSILON;
	const movesTrimEnd =
		segments[segments.length - 1]?.id === clipId &&
		clip.end >= normalized.trimEnd - EPSILON;

	if (edge === "start") {
		if (movesTrimStart) {
			const target = clampEditTime(
				sourceTime,
				0,
				clip.end - MIN_RANGE_DURATION,
			);
			return setTimelineTrim(normalized, target, normalized.trimEnd);
		}
		const target = clampEditTime(
			sourceTime,
			clip.start,
			clip.end - MIN_RANGE_DURATION,
		);
		if (target - clip.start < MIN_RANGE_DURATION) return normalized;
		return dragSplitForShrink(normalized, clip.start, target);
	}

	if (movesTrimEnd) {
		const target = clampEditTime(
			sourceTime,
			clip.start + MIN_RANGE_DURATION,
			normalized.duration,
		);
		return setTimelineTrim(normalized, normalized.trimStart, target);
	}
	const target = clampEditTime(
		sourceTime,
		clip.start + MIN_RANGE_DURATION,
		clip.end,
	);
	if (clip.end - target < MIN_RANGE_DURATION) return normalized;
	return dragSplitForShrink(normalized, clip.end, target);
}

export function getTimelineKeepRanges(
	state: VideoTimelineState,
): VideoEditRange[] {
	const normalized = normalizeTimelineState(state);
	return subtractRanges(
		[{ start: normalized.trimStart, end: normalized.trimEnd }],
		getEffectiveDeletedRanges(normalized),
		normalized.duration,
	);
}

export function getTimelineEditSpec(
	state: VideoTimelineState,
): VideoEditSpecV2 {
	const normalized = normalizeTimelineState(state);
	const manualKeepRanges = subtractRanges(
		[{ start: normalized.trimStart, end: normalized.trimEnd }],
		normalized.deletedRanges,
		normalized.duration,
	);
	return {
		version: 2,
		sourceDuration: normalized.duration,
		manualKeepRanges,
		keepRanges: getTimelineKeepRanges(normalized),
		autoCuts: normalizeAutoCuts(normalized.autoCuts, normalized.duration),
	};
}

export function findNextPlayableTime(
	currentTime: number,
	editSpec: VideoEditSpec,
) {
	const normalized = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	);
	return findNextPlayableTimeInRanges(currentTime, normalized.keepRanges);
}

export function findNextPlayableTimeInRanges(
	currentTime: number,
	keepRanges: readonly VideoEditRange[],
) {
	const rangeIndex = findNextPlayableRangeIndex(currentTime, keepRanges);
	if (rangeIndex < 0) return null;
	const range = keepRanges[rangeIndex];
	if (!range) return null;
	return currentTime < range.start - EPSILON ? range.start : currentTime;
}

function findNextPlayableRangeIndex(
	currentTime: number,
	keepRanges: readonly VideoEditRange[],
) {
	if (!isFiniteNumber(currentTime) || keepRanges.length === 0) return -1;

	let low = 0;
	let high = keepRanges.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const range = keepRanges[middle];
		if (range && currentTime < range.end - EPSILON) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}

	return low < keepRanges.length ? low : -1;
}

export function findPlayableRangeIndex(
	currentTime: number,
	keepRanges: readonly VideoEditRange[],
) {
	const rangeIndex = findNextPlayableRangeIndex(currentTime, keepRanges);
	if (rangeIndex < 0) return -1;
	const range = keepRanges[rangeIndex];
	if (!range || currentTime < range.start - EPSILON) return -1;
	return rangeIndex;
}

export function createTimelineHistory(
	initialState: VideoTimelineState,
): TimelineHistory {
	return {
		entries: [normalizeTimelineState(initialState)],
		index: 0,
	};
}

export function pushTimelineHistory(
	history: TimelineHistory,
	nextState: VideoTimelineState,
): TimelineHistory {
	const normalized = normalizeTimelineState(nextState);
	const current = history.entries[history.index];
	if (current && JSON.stringify(current) === JSON.stringify(normalized)) {
		return history;
	}

	return {
		entries: [...history.entries.slice(0, history.index + 1), normalized],
		index: history.index + 1,
	};
}

export function undoTimelineHistory(history: TimelineHistory): TimelineHistory {
	return {
		...history,
		index: Math.max(0, history.index - 1),
	};
}

export function redoTimelineHistory(history: TimelineHistory): TimelineHistory {
	return {
		...history,
		index: Math.min(history.entries.length - 1, history.index + 1),
	};
}
