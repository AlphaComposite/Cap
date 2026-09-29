import { serverEnv } from "@cap/env";
import { registerEditedDownloadUrlLookup } from "@cap/web-backend";
import { revisionArtifactUrl } from "@/lib/revision-media-grant";

export function ensureEditedDownloadLookup() {
	registerEditedDownloadUrlLookup((input) =>
		revisionArtifactUrl({
			videoId: input.videoId,
			ownerId: input.ownerId,
			artifact: "download",
			child: "download.mp4",
			origin: serverEnv().WEB_URL,
		}),
	);
}
