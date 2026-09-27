"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { editRevision, videoPublication, videos } from "@cap/database/schema";
import { provideOptionalAuth, Storage, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import * as EffectRuntime from "@/lib/server";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function getTranscript(
	videoId: Video.VideoId,
): Promise<{ success: boolean; content?: string; message: string }> {
	const user = await getCurrentUser();

	if (!videoId) {
		return {
			success: false,
			message: "Missing required data for fetching transcript",
		};
	}

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select({ video: videos }).from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) {
		return { success: false, message: "Video not found" };
	}

	const query = exit.value;

	if (query.length === 0) {
		return { success: false, message: "Video not found" };
	}

	const result = query[0];
	if (!result?.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcript is not ready yet",
		};
	}

	if (isInstantFinishEnabledForOwner(video.ownerId)) {
		const [row] = await db()
			.select({ snapshot: editRevision.metadataSnapshot })
			.from(videoPublication)
			.innerJoin(
				editRevision,
				eq(editRevision.revisionId, videoPublication.currentRevisionId),
			)
			.where(
				and(
					eq(videoPublication.videoId, videoId),
					eq(editRevision.state, "CURRENT"),
				),
			)
			.limit(1);
		const content = row?.snapshot?.captionsVtt;
		if (typeof content !== "string") {
			return {
				success: false,
				message: "Transcript is not available for this revision",
			};
		}
		return {
			success: true,
			content,
			message: "Transcript retrieved successfully",
		};
	}

	try {
		const vttContent = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);

			return yield* bucket.getObject(
				`${video.ownerId}/${videoId}/transcription.vtt`,
			);
		}).pipe(runPromise);

		if (Option.isNone(vttContent)) {
			return { success: false, message: "Transcript file not found" };
		}

		return {
			success: true,
			content: vttContent.value,
			message: "Transcript retrieved successfully",
		};
	} catch (error) {
		console.error("[getTranscript] Error fetching transcript:", {
			error: error instanceof Error ? error.message : error,
			videoId,
			userId: user?.id,
		});
		return {
			success: false,
			message: "Failed to fetch transcript",
		};
	}
}
