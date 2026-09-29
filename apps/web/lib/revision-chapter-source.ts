import type { VideoEditSpec } from "@cap/database/types";
import {
	getEditSpecOutputDuration,
	mapOutputChaptersToSource,
	mapSourceTimeToOutputTime,
	normalizeKeepRanges,
	type VideoChapter,
} from "@/lib/video-edits";

const EPSILON = 0.0005;

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

function projectWithSource(
	sourceChapters: readonly VideoChapter[],
	spec: VideoEditSpec,
): { chapter: VideoChapter; source: VideoChapter }[] {
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
	return projected.filter(
		(entry, index) =>
			projected[index + 1] === undefined ||
			(projected[index + 1]?.chapter.start ?? 0) - entry.chapter.start >
				EPSILON,
	);
}

export function projectSourceChapters(
	sourceChapters: readonly VideoChapter[],
	spec: VideoEditSpec,
): VideoChapter[] {
	return projectWithSource(sourceChapters, spec).map((entry) => entry.chapter);
}

function outputChaptersToSource(
	chapters: readonly VideoChapter[],
	spec: VideoEditSpec,
): VideoChapter[] {
	return chapters.flatMap((chapter) =>
		chapter.start <= EPSILON
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
		if (unchangedStart) {
			return [{ ...chapter, start: unchangedStart.source.start }];
		}
		return outputChaptersToSource([chapter], input.currentSpec);
	});
	return sortedUnique([...hidden, ...edited]);
}
