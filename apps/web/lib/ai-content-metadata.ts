import { videos } from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";
import type { GeneratedChapter } from "@/lib/ai-chapter-state";

export function setGeneratedAiContent(
	metadata: SQL,
	field: "chapters",
	value: GeneratedChapter[],
) {
	if (field !== "chapters") {
		throw new Error("Generated AI content only supports chapters");
	}
	const path = "$.chapters";
	const editedPath = "$.chaptersManuallyEdited";
	// The manual-edit flag is authoritative, including for a deliberate empty
	// value whose JSON key may be absent. Generation must never race and restore it.
	return sql`IF(
		JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${editedPath})) = 'true',
		${metadata},
		JSON_SET(${metadata}, ${path}, CAST(${JSON.stringify(value)} AS JSON), ${editedPath}, CAST('false' AS JSON))
	)`;
}

export function setGeneratedRevisionChapters(
	metadata: SQL,
	mapped: {
		chapters: GeneratedChapter[];
		sourceChapters: GeneratedChapter[];
		chaptersRevisionId: string;
	},
) {
	const editedPath = "$.chaptersManuallyEdited";
	return sql`IF(
		JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${editedPath})) = 'true',
		${metadata},
		JSON_SET(${metadata}, '$.chapters', CAST(${JSON.stringify(mapped.chapters)} AS JSON), '$.sourceChapters', CAST(${JSON.stringify(mapped.sourceChapters)} AS JSON), '$.chaptersRevisionId', ${mapped.chaptersRevisionId}, ${editedPath}, CAST('false' AS JSON))
	)`;
}

export function setGeneratedChaptersClearingProvenance(
	metadata: SQL,
	chapters: GeneratedChapter[],
) {
	const written = setGeneratedAiContent(metadata, "chapters", chapters);
	return sql`IF(
		JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.chaptersManuallyEdited')) = 'true',
		${metadata},
		JSON_REMOVE(${written}, '$.chaptersRevisionId', '$.sourceChapters')
	)`;
}
