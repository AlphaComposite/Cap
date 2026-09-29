import type { db } from "@cap/database";
import { editRevision } from "@cap/database/schema";
import { eq, type SQL, sql } from "drizzle-orm";

type Database = ReturnType<typeof db>;

export function revisionSnapshotKeySql(
	key: "downloadReady" | "thumbnailSha256",
	value?: string,
): SQL {
	if (key === "downloadReady") {
		return sql`JSON_SET(COALESCE(${editRevision.metadataSnapshot}, JSON_OBJECT()), '$.downloadReady', CAST('true' AS JSON))`;
	}
	return sql`JSON_SET(COALESCE(${editRevision.metadataSnapshot}, JSON_OBJECT()), '$.thumbnailSha256', CAST(${JSON.stringify(value ?? "")} AS JSON))`;
}

export async function writeRevisionThumbnailSha(
	database: Database,
	revisionId: string,
	digest: string,
) {
	const [revision] = await database
		.select({ metadataSnapshot: editRevision.metadataSnapshot })
		.from(editRevision)
		.where(eq(editRevision.revisionId, revisionId));
	if (!revision?.metadataSnapshot) return;
	await database
		.update(editRevision)
		.set({
			metadataSnapshot: revisionSnapshotKeySql("thumbnailSha256", digest),
		})
		.where(eq(editRevision.revisionId, revisionId));
}
