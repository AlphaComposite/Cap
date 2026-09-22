export type GeneratedChapter = {
	title: string;
	start: number;
};

export type ChapterTranscriptEvidence = {
	start: number;
	text: string;
};

export type ChapterSectionBounds = {
	startTime: number;
	endTime: number;
};

export class InvalidChapterTimestampError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidChapterTimestampError";
	}
}

export function validateChapterOrder(
	chapters: readonly GeneratedChapter[],
): void {
	for (let index = 1; index < chapters.length; index++) {
		const previous = chapters[index - 1];
		const current = chapters[index];
		if (previous && current && current.start <= previous.start) {
			throw new InvalidChapterTimestampError(
				"AI response contained unsorted chapter timestamps; starts must be strictly increasing",
			);
		}
	}
}

export function validateChapterStartsInSection(
	chapters: readonly GeneratedChapter[],
	section: ChapterSectionBounds,
	videoDuration: number,
	transcriptCues: readonly ChapterTranscriptEvidence[] = [],
): void {
	validateChapterOrder(chapters);
	const cuesInSection = transcriptCues.filter(
		(cue) =>
			Number.isFinite(cue.start) &&
			cue.start >= section.startTime &&
			cue.start < section.endTime,
	);

	for (const chapter of chapters) {
		if (
			!Number.isFinite(chapter.start) ||
			chapter.start < 0 ||
			chapter.start >= videoDuration
		) {
			throw new InvalidChapterTimestampError(
				"AI response contained a chapter outside the video duration",
			);
		}
		if (chapter.start < section.startTime || chapter.start >= section.endTime) {
			throw new InvalidChapterTimestampError(
				"AI response contained a chapter outside its transcript section",
			);
		}
		if (
			transcriptCues.length > 0 &&
			!cuesInSection.some(
				(cue) =>
					Math.abs(cue.start - chapter.start) <=
					CHAPTER_START_TOLERANCE_SECONDS,
			)
		) {
			throw new InvalidChapterTimestampError(
				`AI chapter start ${chapter.start} does not align with a transcript cue`,
			);
		}
	}
}

export function clampChapters(
	chapters: readonly GeneratedChapter[],
	videoDuration: number,
): GeneratedChapter[] {
	const filtered = chapters
		.filter(
			(chapter) =>
				Number.isFinite(chapter.start) &&
				chapter.start >= 0 &&
				chapter.start < videoDuration,
		)
		.sort((a, b) => a.start - b.start);

	// A percentage-only gap becomes extremely destructive for long recordings
	// (33 minutes previously meant a 198-second bucket). Cap it at one minute so
	// legitimate section changes survive while near-duplicate model output does not.
	const minGap = Math.max(5, Math.min(60, Math.floor(videoDuration / 20)));
	const deduped: GeneratedChapter[] = [];
	for (const chapter of filtered) {
		const last = deduped[deduped.length - 1];
		if (!last || Math.abs(chapter.start - last.start) >= minGap) {
			deduped.push(chapter);
		}
	}

	return deduped;
}

export function validateGeneratedChapters(
	chapters: unknown,
	videoDuration: number,
	transcriptSegments: ChapterTranscriptEvidence[],
): GeneratedChapter[] {
	if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
		throw new Error("AI chapter validation requires a positive video duration");
	}
	if (!Array.isArray(chapters)) {
		throw new Error("AI response did not contain a valid chapters array");
	}

	const parsed = chapters.map((chapter, index) => {
		if (
			typeof chapter !== "object" ||
			chapter === null ||
			typeof chapter.title !== "string" ||
			!chapter.title.trim() ||
			typeof chapter.start !== "number" ||
			!Number.isFinite(chapter.start) ||
			chapter.start < 0 ||
			chapter.start >= videoDuration
		) {
			throw new Error(
				`AI response contained an invalid chapter at index ${index}`,
			);
		}
		return { title: chapter.title.trim(), start: chapter.start };
	});
	parsed.sort((a, b) => a.start - b.start);
	const uniqueStarts = parsed.filter(
		(chapter, index, sorted) =>
			index === 0 || chapter.start !== sorted[index - 1]?.start,
	);

	validateChapterOrder(uniqueStarts);

	const meaningfulSegments = transcriptSegments
		.filter(
			(segment) =>
				typeof segment.text === "string" &&
				segment.text.trim().length > 0 &&
				Number.isFinite(segment.start) &&
				segment.start >= 0 &&
				segment.start < videoDuration,
		)
		.slice()
		.sort((a, b) => a.start - b.start);

	if (meaningfulSegments.length === 0) {
		if (parsed.length === 0) return [];
		throw new Error("AI chapters cannot be validated without transcript cues");
	}

	const firstMeaningfulStart = meaningfulSegments[0]?.start;
	const matchesTranscriptCue = (start: number) =>
		meaningfulSegments.some(
			(segment) =>
				Math.abs(segment.start - start) <= CHAPTER_START_TOLERANCE_SECONDS,
		);

	let normalized = uniqueStarts
		.map((chapter, index) =>
			index === 0 &&
			chapter.start === 0 &&
			firstMeaningfulStart !== undefined &&
			firstMeaningfulStart > 0
				? { ...chapter, start: firstMeaningfulStart }
				: chapter,
		)
		.filter(
			(chapter, index, chapters) =>
				index === 0 || chapter.start !== chapters[index - 1]?.start,
		);
	if (
		firstMeaningfulStart !== undefined &&
		!normalized.some(
			(chapter) =>
				Math.abs(chapter.start - firstMeaningfulStart) <=
				CHAPTER_START_TOLERANCE_SECONDS,
		)
	) {
		normalized = [
			{ title: "Opening", start: firstMeaningfulStart },
			...normalized,
		];
	}
	validateChapterOrder(normalized);

	for (const chapter of normalized) {
		if (!matchesTranscriptCue(chapter.start)) {
			throw new Error(
				`AI chapter start ${chapter.start} does not align with a transcript cue`,
			);
		}
	}

	const clamped = clampChapters(normalized, videoDuration);
	const minimumChapterCount = getMinimumUsefulChapterCount(
		videoDuration,
		parsed,
		meaningfulSegments,
	);
	if (clamped.length < minimumChapterCount) {
		throw new Error(
			`AI response did not contain at least ${minimumChapterCount} useful chapters`,
		);
	}
	if (minimumChapterCount > 0) {
		const distinctTitles = new Set(
			clamped.map((chapter) => chapter.title.toLocaleLowerCase()),
		);
		if (distinctTitles.size < minimumChapterCount) {
			throw new Error(
				`AI response did not contain at least ${minimumChapterCount} distinct chapter titles`,
			);
		}
	}

	return clamped;
}

/**
 * Only enforce a chapter floor when both the recording and the analysis have
 * strong structural evidence. This deliberately does not force chapters onto
 * short recordings or a long transcript that fit in one coherent section.
 */
export function getMinimumUsefulChapterCount(
	videoDuration: number,
	sectionCandidates: readonly GeneratedChapter[],
	transcriptSegments: ChapterTranscriptEvidence[] = [],
): number {
	if (videoDuration < 29 * 60) return 0;

	const distinctTitles = new Set(
		sectionCandidates
			.filter(
				(candidate) =>
					candidate.title.trim().length > 0 &&
					Number.isFinite(candidate.start) &&
					candidate.start >= 0,
			)
			.map((candidate) =>
				candidate.title.trim().replace(/\s+/g, " ").toLocaleLowerCase(),
			),
	);

	if (distinctTitles.size >= 2) return 2;
	const meaningfulSegments = transcriptSegments.filter(
		(segment) =>
			typeof segment.text === "string" &&
			segment.text.trim().length > 0 &&
			Number.isFinite(segment.start) &&
			segment.start >= 0,
	);
	const hasWideTimelineEvidence =
		meaningfulSegments.some(
			(segment) => segment.start <= videoDuration * 0.25,
		) &&
		meaningfulSegments.some((segment) => segment.start >= videoDuration * 0.6);
	const onlyTitle = [...distinctTitles][0] ?? "";
	const genericTitle =
		/^(?:(?:full|complete|entire|overall)\s+)?(?:(?:video|recording|discussion|presentation|meeting|session)\s+)?(?:overview|summary|introduction(?: and background)?|intro|discussion|main topic|content)$/i.test(
			onlyTitle,
		);
	if (
		(sectionCandidates.length === 0 ||
			(sectionCandidates.length === 1 && genericTitle)) &&
		(transcriptSegments.length === 0 || hasWideTimelineEvidence)
	) {
		return 2;
	}
	return 0;
}

export function getRequiredChapterSynthesisCount(
	videoDuration: number,
	sectionCandidates: readonly GeneratedChapter[],
	transcriptSegments: ChapterTranscriptEvidence[] = [],
): number {
	const minimumChapterCount = getMinimumUsefulChapterCount(
		videoDuration,
		sectionCandidates,
		transcriptSegments,
	);
	if (minimumChapterCount === 0 || sectionCandidates.length === 0) return 0;
	return clampChapters(sectionCandidates, videoDuration).length <
		minimumChapterCount
		? minimumChapterCount
		: 0;
}

const CHAPTER_START_TOLERANCE_SECONDS = 1;
