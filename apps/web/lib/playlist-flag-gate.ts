import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";

export type FlaggedPlaylistGate = "legacy" | "revision" | "unavailable";

const SEGMENT_TYPES = new Set([
	"segments-master",
	"segments-video",
	"segments-audio",
	"segments-status",
	"raw-preview",
]);

export function flaggedPlaylistGate(input: {
	ownerId: string;
	videoType: string;
	fileType?: string;
	sourceType: string;
	env?: NodeJS.ProcessEnv;
}): FlaggedPlaylistGate {
	if (!isInstantFinishEnabledForOwner(input.ownerId, input.env))
		return "legacy";
	const fileType = input.fileType ?? "";
	if (
		fileType === "transcription" ||
		fileType === "enhanced-audio" ||
		SEGMENT_TYPES.has(input.videoType)
	) {
		return "unavailable";
	}
	const mp4Source =
		input.sourceType === "webMP4" || input.sourceType === "desktopMP4";
	if (
		mp4Source &&
		(input.videoType === "mp4" ||
			input.videoType === "master" ||
			input.videoType === "video" ||
			input.videoType === "audio")
	) {
		return "revision";
	}
	return "unavailable";
}
