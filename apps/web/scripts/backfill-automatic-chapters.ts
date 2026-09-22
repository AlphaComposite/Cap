import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { asc, eq } from "drizzle-orm";
import { executeAutomaticChapterBackfillCli } from "../lib/automatic-chapter-backfill-cli";
import { startAiGeneration } from "../lib/generate-ai";

const selectFields = {
	id: videos.id,
	ownerId: videos.ownerId,
	duration: videos.duration,
	transcriptionStatus: videos.transcriptionStatus,
	updatedAt: videos.updatedAt,
	metadata: videos.metadata,
};

async function listVideos(options: { videoId?: string; limit: number }) {
	if (options.videoId) {
		return db()
			.select(selectFields)
			.from(videos)
			.where(eq(videos.id, options.videoId as Video.VideoId))
			.orderBy(asc(videos.id))
			.limit(options.limit);
	}

	return db()
		.select(selectFields)
		.from(videos)
		.orderBy(asc(videos.id))
		.limit(options.limit);
}

async function main() {
	await executeAutomaticChapterBackfillCli(
		process.argv.slice(2),
		{
			listVideos,
			startGeneration: (videoId, ownerId, observedState) =>
				startAiGeneration(videoId as Video.VideoId, ownerId, observedState),
		},
		(line) => console.log(line),
	);
}

main().catch(() => {
	console.error(
		JSON.stringify({ status: "fatal", reason: "backfill-command-failed" }),
	);
	process.exitCode = 1;
});
