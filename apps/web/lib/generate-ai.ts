import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { isAiConfigured } from "@/lib/ai/provider";
import { hasValidChapterState } from "@/lib/ai-chapter-state";
import {
	type AutomaticChapterBackfillObservedState,
	isKnownLegacyAutomaticChapterState,
} from "@/lib/automatic-chapter-backfill";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
	expectedBackfillState?: AutomaticChapterBackfillObservedState,
): Promise<GenerateAiResult> {
	if (!isAiConfigured()) {
		return {
			success: false,
			message: "No AI provider configured",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	const metadata = (video.metadata as VideoMetadata) || {};
	const observedState: AutomaticChapterBackfillObservedState = {
		generationId: metadata.aiGenerationId ?? null,
		generationStatus: metadata.aiGenerationStatus ?? null,
		chaptersJson:
			metadata.chapters === undefined
				? null
				: JSON.stringify(metadata.chapters),
		chaptersManuallyEditedJson:
			metadata.chaptersManuallyEdited === undefined
				? null
				: JSON.stringify(metadata.chaptersManuallyEdited),
		transcriptionStatus: video.transcriptionStatus,
		updatedAtJson: video.updatedAt.toISOString(),
	};
	if (
		expectedBackfillState &&
		JSON.stringify(observedState) !== JSON.stringify(expectedBackfillState)
	) {
		return {
			success: true,
			message: "AI generation changed since backfill scan",
		};
	}
	const claimState = expectedBackfillState ?? observedState;
	const knownLegacyBackfill =
		expectedBackfillState !== undefined &&
		isKnownLegacyAutomaticChapterState({
			duration: video.duration,
			transcriptionStatus: video.transcriptionStatus,
			metadata,
		});

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		metadata.aiGenerationStatus === "COMPLETE" &&
		hasValidChapterState(
			metadata.chapters,
			video.duration,
			metadata.chaptersManuallyEdited,
		) &&
		!knownLegacyBackfill
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	if (metadata.chaptersManuallyEdited === true) {
		return {
			success: true,
			message: "Manual chapters are protected",
		};
	}

	const generationId = randomUUID();

	try {
		const queuedMetadata = knownLegacyBackfill
			? sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'QUEUED', '$.aiGenerationId', ${generationId}, '$.aiChapterBackfillGenerationId', ${generationId})`
			: sql`JSON_REMOVE(JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'QUEUED', '$.aiGenerationId', ${generationId}), '$.aiChapterBackfillGenerationId')`;
		const transitionResult = await db()
			.update(videos)
			.set({
				metadata: queuedMetadata,
			})
			.where(
				and(
					eq(videos.id, videoId),
					eq(videos.updatedAt, video.updatedAt),
					eq(videos.transcriptionStatus, "COMPLETE"),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) <=> ${claimState.generationId}`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) <=> ${claimState.generationStatus}`,
					sql`JSON_EXTRACT(${videos.metadata}, '$.chapters') <=> ${
						claimState.chaptersJson === null
							? null
							: sql`CAST(${claimState.chaptersJson} AS JSON)`
					}`,
					sql`JSON_EXTRACT(${videos.metadata}, '$.chaptersManuallyEdited') <=> ${
						claimState.chaptersManuallyEditedJson === null
							? null
							: sql`CAST(${claimState.chaptersManuallyEditedJson} AS JSON)`
					}`,
					sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')), '') NOT IN ('QUEUED', 'PROCESSING')`,
				),
			);

		if (getAffectedRows(transitionResult) === 0) {
			return {
				success: true,
				message: "AI generation already in progress",
			};
		}

		await start(generateAiWorkflow, [{ videoId, userId, generationId }]);

		return {
			success: true,
			message: "AI generation workflow started",
		};
	} catch {
		await db()
			.update(videos)
			.set({
				metadata: sql`IF(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiChapterBackfillGenerationId')) = ${generationId}, JSON_REMOVE(JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'COMPLETE'), '$.aiChapterBackfillGenerationId', '$.aiGenerationId'), JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR'))`,
			})
			.where(
				and(
					eq(videos.id, videoId),
					eq(videos.transcriptionStatus, "COMPLETE"),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = 'QUEUED'`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) = ${generationId}`,
				),
			);

		return {
			success: false,
			message: "Failed to start AI generation workflow",
		};
	}
}
