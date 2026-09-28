import { videos } from "@cap/database/schema";
import { sql } from "drizzle-orm";
import { instantFinishOwnerAllowlist } from "@/lib/instant-finish-flag";

export function currentVideoDurationFor(owners: readonly string[]) {
	if (owners.length === 0) return sql<number | null>`${videos}.duration`;
	return sql<number | null>`CASE WHEN ${videos}.ownerId IN (${sql.join(
		owners.map((owner) => sql`${owner}`),
		sql`, `,
	)}) THEN COALESCE((
	SELECT CAST(JSON_EXTRACT(cvd_r.metadataSnapshot, '$.durationSeconds') AS DOUBLE)
	FROM video_publication cvd_p
	INNER JOIN edit_revision cvd_r ON cvd_r.revisionId = cvd_p.currentRevisionId
	WHERE cvd_p.videoId = ${videos}.id
), ${videos}.duration) ELSE ${videos}.duration END`.mapWith(Number);
}

export function currentVideoDuration() {
	return currentVideoDurationFor(instantFinishOwnerAllowlist());
}
