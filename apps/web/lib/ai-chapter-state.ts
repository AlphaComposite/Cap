export type GeneratedChapter = { title: string; start: number };

/**
 * A manual empty chapter list is an explicit user decision. Generated output,
 * however, is ready only when it contains chronological, in-duration chapters.
 */
export function hasValidChapterState(
	value: unknown,
	videoDuration: number | null | undefined,
	chaptersManuallyEdited = false,
): value is GeneratedChapter[] {
	if (chaptersManuallyEdited && Array.isArray(value) && value.length === 0) {
		return true;
	}

	if (
		typeof videoDuration !== "number" ||
		!Number.isFinite(videoDuration) ||
		videoDuration <= 0 ||
		!Array.isArray(value) ||
		value.length === 0
	) {
		return false;
	}

	let previousStart = 0;
	return value.every((chapter, index) => {
		if (
			typeof chapter !== "object" ||
			chapter === null ||
			typeof chapter.title !== "string" ||
			chapter.title.trim().length === 0 ||
			typeof chapter.start !== "number" ||
			!Number.isFinite(chapter.start) ||
			chapter.start < 0 ||
			chapter.start >= videoDuration ||
			(index > 0 && chapter.start <= previousStart)
		) {
			return false;
		}
		previousStart = chapter.start;
		return true;
	});
}
