import { videos } from "@cap/database/schema";
import { type SQL, sql } from "drizzle-orm";

export function setGeneratedAiContent(
	metadata: SQL,
	field: "summary" | "chapters",
	value: string | { title: string; start: number }[],
) {
	const path = `$.${field}`;
	const editedPath = `$.${field}ManuallyEdited`;
	// The manual-edit flag is authoritative, including for a deliberate empty
	// value whose JSON key may be absent. Generation must never race and restore it.
	return sql`IF(
		JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, ${editedPath})) = 'true',
		${metadata},
		JSON_SET(${metadata}, ${path}, CAST(${JSON.stringify(value)} AS JSON), ${editedPath}, CAST('false' AS JSON))
	)`;
}
