import type { VideoMetadata } from "@cap/database/types";
import type { ViewerSettings } from "@cap/web-backend";

type AiVisibilitySettings = Pick<
	ViewerSettings,
	"disableSummary" | "disableChapters"
>;

export function filterVideoMetadataForViewer(
	metadata: VideoMetadata,
	settings: AiVisibilitySettings,
	isOwner: boolean,
): VideoMetadata {
	if (isOwner) return metadata;

	const filteredMetadata = { ...metadata };
	if (settings.disableSummary) delete filteredMetadata.summary;
	if (settings.disableChapters) delete filteredMetadata.chapters;
	return filteredMetadata;
}

export function filterAiDataForViewer(
	metadata: VideoMetadata,
	settings: AiVisibilitySettings,
	isOwner: boolean,
) {
	return {
		title: metadata.aiTitle || null,
		summary:
			!isOwner && settings.disableSummary ? null : metadata.summary || null,
		chapters:
			!isOwner && settings.disableChapters ? null : metadata.chapters || null,
		aiGenerationStatus: metadata.aiGenerationStatus || null,
	};
}
