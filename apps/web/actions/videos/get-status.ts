"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizations,
	spaces,
	spaceVideos,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import {
	provideOptionalAuth,
	resolveEffectiveVideoRules,
	VideosPolicy,
} from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import {
	isRetryableDesktopSegmentsFinalizationError,
	queueDesktopSegmentsFinalization,
} from "@/lib/desktop-segments-finalization";
import * as EffectRuntime from "@/lib/server";
import { filterAiDataForViewer } from "@/lib/server-ai-data-visibility";
import { transcribeVideo } from "../../lib/transcribe";

type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

export interface VideoStatusResult {
	transcriptionStatus: TranscriptionStatus | null;
	aiGenerationStatus: AiGenerationStatus | null;
	name: string | null;
	aiTitle: string | null;
	summary: string | null;
	chapters: { title: string; start: number }[] | null;
	error?: string;
}

export async function getVideoStatus(
	videoId: Video.VideoId,
): Promise<VideoStatusResult | { success: false }> {
	if (!videoId) throw new Error("Video ID not provided");

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) return { success: false };

	const video = exit.value[0];
	if (!video) throw new Error("Video not found");

	const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};
	const [user, organizationRows, sharedSpaces] = await Promise.all([
		getCurrentUser(),
		db()
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, video.orgId))
			.limit(1),
		db()
			.select({
				id: spaces.id,
				name: spaces.name,
				settings: spaces.settings,
			})
			.from(spaceVideos)
			.innerJoin(spaces, eq(spaceVideos.spaceId, spaces.id))
			.where(eq(spaceVideos.videoId, videoId)),
	]);
	const rules = resolveEffectiveVideoRules({
		videoSettings: video.settings,
		organizationSettings: organizationRows[0]?.settings,
		spaces: sharedSpaces,
	});
	const aiData = filterAiDataForViewer(
		metadata,
		rules.settings,
		user?.id === video.ownerId,
	);

	if (!video.transcriptionStatus && serverEnv().ASSEMBLY_API_KEY) {
		const activeUpload = await db()
			.select({
				videoId: videoUploads.videoId,
				phase: videoUploads.phase,
				processingError: videoUploads.processingError,
			})
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId))
			.limit(1);

		if (activeUpload.length > 0) {
			const upload = activeUpload[0];
			if (
				video.source?.type === "desktopSegments" &&
				upload?.phase === "error" &&
				isRetryableDesktopSegmentsFinalizationError(upload.processingError)
			) {
				queueDesktopSegmentsFinalization({
					videoId,
					userId: video.ownerId,
				}).catch((error) => {
					console.error(
						`[Get Status] Error queueing segment finalization for video ${videoId}:`,
						error,
					);
				});
			}

			return {
				transcriptionStatus: null,
				aiGenerationStatus: aiData.aiGenerationStatus,
				name: video.name,
				aiTitle: aiData.title,
				summary: aiData.summary,
				chapters: aiData.chapters,
			};
		}

		console.log(
			`[Get Status] Transcription not started for video ${videoId}, triggering transcription`,
		);
		try {
			transcribeVideo(videoId, video.ownerId).catch((error) => {
				console.error(
					`[Get Status] Error starting transcription for video ${videoId}:`,
					error,
				);
			});

			return {
				transcriptionStatus: "PROCESSING",
				aiGenerationStatus: aiData.aiGenerationStatus,
				name: video.name,
				aiTitle: aiData.title,
				summary: aiData.summary,
				chapters: aiData.chapters,
			};
		} catch (error) {
			console.error(
				`[Get Status] Error triggering transcription for video ${videoId}:`,
				error,
			);
			return {
				transcriptionStatus: "ERROR",
				aiGenerationStatus: aiData.aiGenerationStatus,
				name: video.name,
				aiTitle: aiData.title,
				summary: aiData.summary,
				chapters: aiData.chapters,
				error: "Failed to start transcription",
			};
		}
	}

	if (video.transcriptionStatus === "ERROR") {
		return {
			transcriptionStatus: "ERROR",
			aiGenerationStatus: aiData.aiGenerationStatus,
			name: video.name,
			aiTitle: aiData.title,
			summary: aiData.summary,
			chapters: aiData.chapters,
			error: "Transcription failed",
		};
	}

	return {
		transcriptionStatus:
			(video.transcriptionStatus as TranscriptionStatus) || null,
		aiGenerationStatus: aiData.aiGenerationStatus,
		name: video.name,
		aiTitle: aiData.title,
		summary: aiData.summary,
		chapters: aiData.chapters,
	};
}
