import type { VideoAutoCuts, VideoEditSpecV2 } from "@cap/database/types";

const EPSILON = 0.001;

export function defaultAutoCuts(): VideoAutoCuts {
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

export function roundIdentityDuration(duration: number): number {
	if (!Number.isFinite(duration) || duration <= 0) return 0;
	return Math.round(duration * 1000) / 1000;
}

export function canonicalIdentitySpec(sourceDuration: number): VideoEditSpecV2 {
	const duration = roundIdentityDuration(sourceDuration);
	const full = [{ start: 0, end: duration }];
	return {
		version: 2,
		sourceDuration: duration,
		manualKeepRanges: full,
		keepRanges: full,
		autoCuts: defaultAutoCuts(),
	};
}

function rangesMatch(
	left: { start: number; end: number }[] | undefined,
	right: { start: number; end: number }[],
): boolean {
	if (!left || left.length !== right.length) return false;
	return left.every(
		(range, index) =>
			Math.abs(range.start - (right[index]?.start ?? Number.NaN)) <= EPSILON &&
			Math.abs(range.end - (right[index]?.end ?? Number.NaN)) <= EPSILON,
	);
}

function exactDocument(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object")
		return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => exactDocument(value, right[index]))
		);
	}
	const a = left as Record<string, unknown>;
	const b = right as Record<string, unknown>;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && exactDocument(a[key], b[key]))
	);
}

function finiteRanges(value: unknown): { start: number; end: number }[] | null {
	if (!Array.isArray(value)) return null;
	const ranges: { start: number; end: number }[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const start = (item as { start?: unknown }).start;
		const end = (item as { end?: unknown }).end;
		if (typeof start !== "number" || typeof end !== "number") return null;
		if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
		ranges.push({ start, end });
	}
	return ranges;
}

export function isCanonicalIdentitySpec(spec: unknown): boolean {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
	const record = spec as {
		version?: unknown;
		sourceDuration?: unknown;
		keepRanges?: unknown;
		manualKeepRanges?: unknown;
		autoCuts?: VideoAutoCuts;
		autoCutsInitialized?: unknown;
	};
	if (
		record.version !== 2 ||
		typeof record.sourceDuration !== "number" ||
		!Number.isFinite(record.sourceDuration) ||
		record.sourceDuration <= 0
	) {
		return false;
	}
	if (record.autoCutsInitialized !== undefined) return false;
	const keepRanges = finiteRanges(record.keepRanges);
	const manualKeepRanges = finiteRanges(record.manualKeepRanges);
	if (!keepRanges || !manualKeepRanges) return false;
	const expected = canonicalIdentitySpec(record.sourceDuration);
	if (
		!rangesMatch(keepRanges, expected.keepRanges) ||
		!rangesMatch(manualKeepRanges, expected.manualKeepRanges)
	) {
		return false;
	}
	return exactDocument(record.autoCuts, expected.autoCuts);
}

export function intentBlocksOriginal(spec: unknown): boolean {
	return !isCanonicalIdentitySpec(spec);
}
