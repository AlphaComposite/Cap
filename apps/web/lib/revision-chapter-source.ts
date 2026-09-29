import type { VideoEditSpec } from "@cap/database/types";
import {
	getEditSpecOutputDuration,
	mapOutputChaptersToSource,
	mapSourceTimeToOutputTime,
	normalizeKeepRanges,
	type VideoChapter,
} from "@/lib/video-edits";

const EPSILON = 0.0005;
export const MIN_CHAPTER_SECONDS = 10;

function overlaps(left: number, right: number) {
	return Math.abs(left - right) <= EPSILON;
}

function nextFreeSourceStart(start: number, taken: readonly number[]) {
	let steps = 1;
	let candidate = Math.round(start * 1000 + steps) / 1000;
	while (taken.some((time) => overlaps(time, candidate))) {
		steps += 1;
		candidate = Math.round(start * 1000 + steps) / 1000;
	}
	return candidate;
}

function preserveHiddenChapters(
	hidden: readonly VideoChapter[],
	edited: readonly VideoChapter[],
): VideoChapter[] {
	const editedStarts = edited.map((chapter) => chapter.start);
	const collided = (chapter: VideoChapter) =>
		editedStarts.some((start) => overlaps(start, chapter.start));
	if (!hidden.some(collided)) return [...hidden];
	const staying = hidden
		.filter((chapter) => !collided(chapter))
		.map((chapter) => chapter.start);
	const taken = [...editedStarts, ...staying];
	return hidden.map((chapter) => {
		if (!collided(chapter)) return chapter;
		const start = nextFreeSourceStart(chapter.start, taken);
		taken.push(start);
		return { ...chapter, start };
	});
}

function sortedUnique(chapters: readonly VideoChapter[]): VideoChapter[] {
	const sorted = [...chapters].sort((a, b) => a.start - b.start);
	return sorted.filter(
		(chapter, index) =>
			sorted[index + 1] === undefined ||
			(sorted[index + 1] as VideoChapter).start - chapter.start > EPSILON,
	);
}

function firstKeptTimeAtOrAfter(time: number, spec: VideoEditSpec) {
	const normalized = normalizeKeepRanges(spec.keepRanges, spec.sourceDuration);
	for (const range of normalized.keepRanges) {
		if (range.end - EPSILON <= time) continue;
		return Math.max(range.start, time);
	}
	return null;
}

type ProjectedChapter = {
	chapter: VideoChapter;
	source: VideoChapter;
	startShifted: boolean;
};

function projectWithSource(
	sourceChapters: readonly VideoChapter[],
	spec: VideoEditSpec,
): ProjectedChapter[] {
	const sorted = sortedUnique(sourceChapters);
	const outputEnd = getEditSpecOutputDuration(spec);
	const projected = sorted.flatMap((source, index) => {
		const contentEnd = sorted[index + 1]?.start ?? spec.sourceDuration;
		const kept = firstKeptTimeAtOrAfter(source.start, spec);
		if (kept === null || kept >= contentEnd - EPSILON) return [];
		const start = mapSourceTimeToOutputTime(kept, spec);
		if (start === null || start >= outputEnd - EPSILON) return [];
		return [{ chapter: { ...source, start }, source }];
	});
	const deduped = projected.filter(
		(entry, index) =>
			projected[index + 1] === undefined ||
			(projected[index + 1]?.chapter.start ?? 0) - entry.chapter.start >
				EPSILON,
	);
	return hideShortChapters(deduped, outputEnd);
}

function hideShortChapters(
	projected: { chapter: VideoChapter; source: VideoChapter }[],
	outputEnd: number,
): ProjectedChapter[] {
	const entries = projected.map((entry) => ({
		chapter: { ...entry.chapter },
		source: entry.source,
		startShifted: false,
	}));
	while (entries.length > 1) {
		let shortestIndex = -1;
		let shortestLength = Number.POSITIVE_INFINITY;
		for (const [index, entry] of entries.entries()) {
			const nextStart = entries[index + 1]?.chapter.start ?? outputEnd;
			const length = nextStart - entry.chapter.start;
			if (length >= MIN_CHAPTER_SECONDS - EPSILON || length >= shortestLength) {
				continue;
			}
			shortestLength = length;
			shortestIndex = index;
		}
		if (shortestIndex < 0) break;
		if (shortestIndex === 0) {
			const removed = entries.shift();
			const next = entries[0];
			if (removed && next) {
				next.chapter = { ...next.chapter, start: removed.chapter.start };
				next.startShifted = true;
			}
		} else {
			entries.splice(shortestIndex, 1);
		}
	}
	return entries;
}

export function projectSourceChapters(
	sourceChapters: readonly VideoChapter[],
	spec: VideoEditSpec,
): VideoChapter[] {
	return projectWithSource(sourceChapters, spec).map((entry) => entry.chapter);
}

export function outputChaptersToSource(
	chapters: readonly VideoChapter[],
	spec: VideoEditSpec,
): VideoChapter[] {
	return chapters.flatMap((chapter) =>
		chapter.start <= 0
			? [{ ...chapter, start: 0 }]
			: mapOutputChaptersToSource([chapter], spec),
	);
}

export function deriveRevisionChapterState(input: {
	storedChapters: readonly VideoChapter[];
	storedSourceChapters: readonly VideoChapter[] | null | undefined;
	previousSpec: VideoEditSpec;
	nextSpec: VideoEditSpec;
}): { sourceChapters: VideoChapter[]; chapters: VideoChapter[] } {
	const sourceChapters = sortedUnique(
		input.storedSourceChapters ??
			outputChaptersToSource(input.storedChapters, input.previousSpec),
	);
	return {
		sourceChapters,
		chapters: projectSourceChapters(sourceChapters, input.nextSpec),
	};
}

export function mergeOwnerChapterEdit(input: {
	previousSourceChapters: readonly VideoChapter[];
	currentSpec: VideoEditSpec;
	editedChapters: readonly VideoChapter[];
}): VideoChapter[] {
	const visible = projectWithSource(
		input.previousSourceChapters,
		input.currentSpec,
	);
	const visibleSources = new Set(visible.map((entry) => entry.source));
	const hidden = sortedUnique(input.previousSourceChapters).filter(
		(chapter) =>
			!visibleSources.has(chapter) &&
			![...visibleSources].some(
				(source) => Math.abs(source.start - chapter.start) <= EPSILON,
			),
	);
	const edited = input.editedChapters.flatMap((chapter) => {
		const unchangedStart = visible.find(
			(entry) => Math.abs(entry.chapter.start - chapter.start) <= EPSILON,
		);
		if (unchangedStart && (chapter.start > 0 || unchangedStart.startShifted)) {
			return [{ ...chapter, start: unchangedStart.source.start }];
		}
		return outputChaptersToSource([chapter], input.currentSpec);
	});
	return sortedUnique([...preserveHiddenChapters(hidden, edited), ...edited]);
}
