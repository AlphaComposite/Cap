import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { type User, Video } from "@cap/web-domain";
import { Effect, Schema } from "effect";
import { isViewerPrivateKey, loadEligibleLegacy } from "@/lib/flagged-unedited";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { runPromise } from "@/lib/server";

type SharePlaybackVideo = Omit<
	typeof videos.$inferSelect,
	"folderId" | "password" | "settings" | "ownerId"
> & { owner: { id: User.UserId } };

export const getSharePlaybackUrl = (video: SharePlaybackVideo) =>
	Effect.gen(function* () {
		if (isInstantFinishEnabledForOwner(video.owner.id)) {
			const eligible = yield* Effect.promise(() =>
				loadEligibleLegacy({
					videoId: video.id,
					ownerId: video.owner.id,
				}),
			);
			if (!eligible) return null;
		}
		const loadedVideo = yield* Schema.decodeUnknown(Video.Video)({
			...video,
			ownerId: video.owner.id,
			bucketId: video.bucket,
			folderId: null,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
		});
		const [bucket] = yield* Storage.getAccessForVideo(loadedVideo);
		const playbackKey = `${video.owner.id}/${video.id}/result.mp4`;
		if (isViewerPrivateKey(playbackKey)) return null;
		return yield* bucket.getSignedObjectUrl(playbackKey);
	})
		.pipe(runPromise)
		.catch(() => null);
