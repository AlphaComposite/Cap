import type { VideoEditSpec } from "@cap/database/types";
import type { VideoTimelineState } from "@/lib/video-edits";
import {
	areEditSpecDocumentsEquivalent,
	normalizeTimelineState,
	parseVideoEditSpec,
} from "@/lib/video-edits";

export type TimelineDraftStorage = Pick<
	Storage,
	"getItem" | "removeItem" | "setItem"
>;

const TIMELINE_DRAFT_VERSION = 3;

type StoredTimelineDraft = {
	version: typeof TIMELINE_DRAFT_VERSION;
	duration: number;
	baselineEditSpec: VideoEditSpec;
	state: VideoTimelineState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumberValue(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isStoredEditRange(value: unknown) {
	return (
		isRecord(value) &&
		isFiniteNumberValue(value.start) &&
		isFiniteNumberValue(value.end)
	);
}

function isStoredTimelineState(value: unknown): value is VideoTimelineState {
	if (
		isRecord(value) &&
		isFiniteNumberValue(value.duration) &&
		value.duration > 0 &&
		(value.autoCutsInitialized === undefined ||
			typeof value.autoCutsInitialized === "boolean") &&
		isFiniteNumberValue(value.trimStart) &&
		isFiniteNumberValue(value.trimEnd) &&
		Array.isArray(value.splitPoints) &&
		value.splitPoints.length <= 5_000 &&
		value.splitPoints.every(isFiniteNumberValue) &&
		Array.isArray(value.deletedRanges) &&
		value.deletedRanges.length <= 5_000 &&
		value.deletedRanges.every(isStoredEditRange) &&
		(value.selectedSegmentId === null ||
			(typeof value.selectedSegmentId === "string" &&
				value.selectedSegmentId.length <= 256))
	) {
		try {
			parseVideoEditSpec({
				version: 2,
				...(typeof value.autoCutsInitialized === "boolean"
					? { autoCutsInitialized: value.autoCutsInitialized }
					: {}),
				sourceDuration: value.duration,
				keepRanges: [{ start: 0, end: value.duration }],
				manualKeepRanges: [{ start: 0, end: value.duration }],
				autoCuts: value.autoCuts,
			});
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

export function getTimelineDraftKey(videoId: string) {
	return `cap:edit-timeline-draft:${videoId}`;
}

export function getTimelineDraftStorage(): TimelineDraftStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function serializeTimelineDraft(
	duration: number,
	state: VideoTimelineState,
	baselineEditSpec: VideoEditSpec,
) {
	const draft: StoredTimelineDraft = {
		version: TIMELINE_DRAFT_VERSION,
		duration,
		baselineEditSpec,
		state: normalizeTimelineState({ ...state, duration }),
	};
	return JSON.stringify(draft);
}

export function parseTimelineDraft(
	raw: string | null,
	duration: number,
	baselineEditSpec: VideoEditSpec,
) {
	if (!raw) return null;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			parsed.version !== TIMELINE_DRAFT_VERSION ||
			!isFiniteNumberValue(parsed.duration) ||
			Math.abs(parsed.duration - duration) > 0.01 ||
			!isRecord(parsed.baselineEditSpec) ||
			!isStoredTimelineState(parsed.state)
		) {
			return null;
		}
		const storedBaseline = parseVideoEditSpec(parsed.baselineEditSpec);
		if (!areEditSpecDocumentsEquivalent(storedBaseline, baselineEditSpec)) {
			return null;
		}
		return normalizeTimelineState({ ...parsed.state, duration });
	} catch {
		return null;
	}
}

export function readTimelineDraft(
	storage: TimelineDraftStorage,
	storageKey: string,
	duration: number,
	baselineEditSpec: VideoEditSpec,
) {
	try {
		return parseTimelineDraft(
			storage.getItem(storageKey),
			duration,
			baselineEditSpec,
		);
	} catch {
		return null;
	}
}

export function writeTimelineDraft(
	storage: TimelineDraftStorage,
	storageKey: string,
	duration: number,
	state: VideoTimelineState,
	baselineEditSpec: VideoEditSpec,
) {
	try {
		storage.setItem(
			storageKey,
			serializeTimelineDraft(duration, state, baselineEditSpec),
		);
	} catch {
		return;
	}
}

export function clearTimelineDraft(
	storage: TimelineDraftStorage,
	storageKey: string,
) {
	try {
		storage.removeItem(storageKey);
	} catch {
		return;
	}
}
