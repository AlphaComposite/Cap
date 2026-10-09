import { registerEditedThumbnailUrlLookup } from "@cap/web-backend";
import { revisionArtifactUrl } from "@/lib/revision-media-grant";

export function ensureEditedThumbnailLookup() {
	registerEditedThumbnailUrlLookup((input) =>
		revisionArtifactUrl({
			...input,
			artifact: "thumbnail",
			child: "thumbnail.jpg",
		}),
	);
}
