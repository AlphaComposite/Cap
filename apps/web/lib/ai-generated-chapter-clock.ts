import type { VideoEditSpec } from "@cap/database/types";
import { projectSourceChapters } from "@/lib/revision-chapter-source";
import type { VideoChapter } from "@/lib/video-edits";

export function mapGeneratedSourceChapters(input: {
	generatedChapters: readonly VideoChapter[];
	spec: VideoEditSpec;
	revisionId: string;
}): {
	sourceChapters: VideoChapter[];
	chapters: VideoChapter[];
	chaptersRevisionId: string;
} {
	const sourceChapters = input.generatedChapters.map((chapter) => ({
		title: chapter.title,
		start: chapter.start,
	}));
	return {
		sourceChapters,
		chapters: projectSourceChapters(sourceChapters, input.spec),
		chaptersRevisionId: input.revisionId,
	};
}
