import { serverEnv } from "@cap/env";
import { registerEditedDownloadUrlLookup } from "@cap/web-backend";
import { User, Video } from "@cap/web-domain";
import { revisionArtifactUrl } from "@/lib/revision-media-grant";
import { canUserDownloadVideo } from "@/lib/video-download-permissions";

export function ensureEditedDownloadLookup() {
	registerEditedDownloadUrlLookup(
		async (input: {
			videoId: string;
			ownerId: string;
			userId: string | null;
		}) => {
			if (!input.userId) return { status: "forbidden" };
			const allowed = await canUserDownloadVideo({
				userId: User.UserId.make(input.userId),
				ownerId: User.UserId.make(input.ownerId),
				videoId: Video.VideoId.make(input.videoId),
			});
			if (!allowed) return { status: "forbidden" };
			return {
				status: "allowed",
				downloadUrl: await revisionArtifactUrl({
					videoId: input.videoId,
					ownerId: input.ownerId,
					artifact: "download",
					child: "download.mp4",
					origin: serverEnv().WEB_URL,
				}),
			};
		},
	);
}
