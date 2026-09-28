import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { findScreenshotObjectKey, Storage } from "@cap/web-backend";
import { getPublishedRecordingThumbnailKey } from "@cap/web-backend/src/Storage/recording-output";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { currentVideoDuration } from "@/lib/current-video-duration";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { extractPosterFrameDataUri } from "@/lib/og/poster-frame";
import { renderVideoOg } from "@/lib/og/video-og";
import { revisionArtifactUrl } from "@/lib/revision-media-grant";
import { neutralPreviewJpeg } from "@/lib/revision-thumbnail";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function generateVideoOgImage(videoId: Video.VideoId) {
	const videoData = await getData(videoId);

	if (!videoData) return renderVideoOg({ kind: "not-found" });

	const { video, ownerName, currentDuration } = videoData;

	if (video.password) return renderVideoOg({ kind: "password" });
	if (video.public === false) return renderVideoOg({ kind: "locked" });

	if (isInstantFinishEnabledForOwner(video.ownerId)) {
		const screenshotUrl = await revisionArtifactUrl({
			videoId,
			ownerId: video.ownerId,
			artifact: "thumbnail",
			child: "thumbnail.jpg",
		}).catch(() => null);
		return renderVideoOg({
			kind: "video",
			video: {
				title: video.name,
				ownerName: ownerName ?? undefined,
				duration: currentDuration ?? undefined,
				screenshotUrl:
					screenshotUrl ??
					`data:image/jpeg;base64,${neutralPreviewJpeg().toString("base64")}`,
			},
		});
	}

	let screenshotUrl: string | undefined;

	try {
		await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			const publishedThumbnail = getPublishedRecordingThumbnailKey(video);
			if (publishedThumbnail) {
				screenshotUrl = yield* bucket.getSignedObjectUrl(publishedThumbnail);
				return;
			}
			const listResponse = yield* bucket.listObjects({
				prefix: `${video.ownerId}/${video.id}/`,
			});
			const screenshotKey = findScreenshotObjectKey(
				listResponse.Contents || [],
			);

			if (!screenshotKey) return;
			screenshotUrl = yield* bucket.getSignedObjectUrl(screenshotKey);
		}).pipe(runPromise);
	} catch (error) {
		console.error("Error generating URL for screenshot:", error);
	}

	// The media pipeline writes the screenshot asynchronously — fall back to
	// grabbing a frame from the playable source so fresh uploads still get a
	// real thumbnail.
	if (!screenshotUrl) {
		screenshotUrl = await extractPosterFrameDataUri(video.id).catch(
			() => undefined,
		);
	}

	return renderVideoOg({
		kind: "video",
		video: {
			title: video.name,
			ownerName: ownerName ?? undefined,
			duration: video.duration ?? undefined,
			screenshotUrl,
		},
	});
}

async function getData(videoId: Video.VideoId) {
	const query = await db()
		.select({
			video: videos,
			ownerName: users.name,
			currentDuration: currentVideoDuration(),
		})
		.from(videos)
		.leftJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId));

	const result = query[0];

	if (!result) return;

	return result;
}
