import { videos } from "@cap/database/schema";
import { sql } from "drizzle-orm";

export const currentVideoDuration = sql<number | null>`COALESCE((
	SELECT CAST(JSON_EXTRACT(cvd_r.metadataSnapshot, '$.durationSeconds') AS DOUBLE)
	FROM video_publication cvd_p
	INNER JOIN edit_revision cvd_r ON cvd_r.revisionId = cvd_p.currentRevisionId
	WHERE cvd_p.videoId = ${videos}.id
), ${videos}.duration)`.mapWith(Number);
